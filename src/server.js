const path = require("node:path");
const { spawn } = require("node:child_process");

const dotenv = require("dotenv");
const express = require("express");
const mysql = require("mysql2/promise");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const port = Number(process.env.APP_PORT || process.env.PORT || 3000);
const publicDir = path.join(__dirname, "..", "public");
const projectRoot = path.join(__dirname, "..");
let recalculation = null;

const requiredEnv = ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  throw new Error(`Missing required environment variables: ${missingEnv.join(", ")}`);
}

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 8),
  charset: "utf8mb4",
  decimalNumbers: true,
});

const allowedDimensions = new Set(["global", "country", "company", "component"]);
const allowedEntityTypes = new Set(["country", "company"]);

app.use(express.json());
app.use(express.static(publicDir));

function toInt(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function csvList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function placeholders(items) {
  return items.map(() => "?").join(", ");
}

async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function latestRunId() {
  const rows = await query("SELECT run_id FROM model_runs ORDER BY imported_at DESC LIMIT 1");
  if (!rows.length) {
    const error = new Error("No model runs found in database");
    error.status = 404;
    throw error;
  }
  return rows[0].run_id;
}

async function resolveRunId(req) {
  return req.query.run_id ? String(req.query.run_id) : latestRunId();
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

app.get(
  "/api/health",
  asyncRoute(async (req, res) => {
    const [ping] = await query("SELECT 1 AS ok");
    const runId = await latestRunId();
    res.json({ ok: ping.ok === 1, run_id: runId, database: process.env.MYSQL_DATABASE });
  }),
);

app.get(
  "/api/runs",
  asyncRoute(async (req, res) => {
    const rows = await query(
      `SELECT run_id, workbook_file, workbook_sha256, forecast_start_year, forecast_end_year, imported_at
       FROM model_runs
       ORDER BY imported_at DESC`,
    );
    res.json({ rows });
  }),
);

app.get(
  "/api/options",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    const [countries, companies, components, years] = await Promise.all([
      query(
        `SELECT item_name AS name
         FROM share_assumptions
         WHERE run_id = ? AND dimension_name = 'country'
         ORDER BY item_name`,
        [runId],
      ),
      query(
        `SELECT item_name AS name
         FROM share_assumptions
         WHERE run_id = ? AND dimension_name = 'company'
         ORDER BY item_name`,
        [runId],
      ),
      query(
        `SELECT item_name AS name
         FROM share_assumptions
         WHERE run_id = ? AND dimension_name = 'component'
         ORDER BY item_name`,
        [runId],
      ),
      query(
        `SELECT year_num AS year
         FROM global_forecast
         WHERE run_id = ?
         ORDER BY year_num`,
        [runId],
      ),
    ]);
    res.json({
      run_id: runId,
      countries: countries.map((row) => row.name),
      companies: companies.map((row) => row.name),
      components: components.map((row) => row.name),
      years: years.map((row) => row.year),
    });
  }),
);

app.get(
  "/api/summary",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    const [runRows, keyYears, cumulative, sourceRows, counts] = await Promise.all([
      query(
        `SELECT run_id, workbook_file, forecast_start_year, forecast_end_year, imported_at
         FROM model_runs
         WHERE run_id = ?`,
        [runId],
      ),
      query(
        `SELECT year_num, total_usd_bn, yoy_growth
         FROM global_forecast
         WHERE run_id = ? AND year_num IN (2026, 2030, 2045)
         ORDER BY year_num`,
        [runId],
      ),
      query(
        `SELECT SUM(total_usd_bn) AS cumulative_usd_bn
         FROM global_forecast
         WHERE run_id = ?`,
        [runId],
      ),
      query("SELECT COUNT(*) AS source_count FROM source_register WHERE run_id = ?", [runId]),
      query(
        `SELECT dimension_name, year_num, SUM(amount_usd_bn) AS amount_usd_bn
         FROM forecast_totals
         WHERE run_id = ? AND dimension_name IN ('country', 'company', 'component')
           AND year_num IN (2026, 2030, 2045)
         GROUP BY dimension_name, year_num
         ORDER BY dimension_name, year_num`,
        [runId],
      ),
    ]);
    res.json({
      run: runRows[0],
      key_years: keyYears,
      cumulative_usd_bn: cumulative[0]?.cumulative_usd_bn || 0,
      source_count: sourceRows[0]?.source_count || 0,
      reconciliation: counts,
    });
  }),
);

app.get(
  "/api/global",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    const rows = await query(
      `SELECT year_num, total_usd_bn, yoy_growth
       FROM global_forecast
       WHERE run_id = ?
       ORDER BY year_num`,
      [runId],
    );
    res.json({ run_id: runId, rows });
  }),
);

app.get(
  "/api/breakdown/:dimension",
  asyncRoute(async (req, res) => {
    const dimension = req.params.dimension;
    if (!allowedDimensions.has(dimension) || dimension === "global") {
      return res.status(400).json({ error: "dimension must be country, company, or component" });
    }
    const runId = await resolveRunId(req);
    const year = toInt(req.query.year, 2030, { min: 2026, max: 2045 });
    const limit = toInt(req.query.limit, 20, { min: 1, max: 100 });
    const rows = await query(
      `SELECT item_name, share_of_global, amount_usd_bn
       FROM forecast_totals
       WHERE run_id = ? AND dimension_name = ? AND year_num = ?
       ORDER BY amount_usd_bn DESC
       LIMIT ?`,
      [runId, dimension, year, limit],
    );
    res.json({ run_id: runId, dimension, year, rows });
  }),
);

app.get(
  "/api/timeseries",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    const dimension = String(req.query.dimension || "global");
    if (!allowedDimensions.has(dimension)) {
      return res.status(400).json({ error: "invalid dimension" });
    }

    if (dimension === "global") {
      const rows = await query(
        `SELECT 'Global total' AS item_name, year_num, total_usd_bn AS amount_usd_bn, yoy_growth
         FROM global_forecast
         WHERE run_id = ?
         ORDER BY year_num`,
        [runId],
      );
      return res.json({ run_id: runId, dimension, rows });
    }

    let items = csvList(req.query.items);
    if (!items.length) {
      const year = toInt(req.query.rank_year, 2030, { min: 2026, max: 2045 });
      const topRows = await query(
        `SELECT item_name
         FROM forecast_totals
         WHERE run_id = ? AND dimension_name = ? AND year_num = ?
         ORDER BY amount_usd_bn DESC
         LIMIT 6`,
        [runId, dimension, year],
      );
      items = topRows.map((row) => row.item_name);
    }
    if (!items.length) return res.json({ run_id: runId, dimension, rows: [] });

    const rows = await query(
      `SELECT item_name, year_num, amount_usd_bn, share_of_global
       FROM forecast_totals
       WHERE run_id = ? AND dimension_name = ? AND item_name IN (${placeholders(items)})
       ORDER BY item_name, year_num`,
      [runId, dimension, ...items],
    );
    res.json({ run_id: runId, dimension, items, rows });
  }),
);

app.get(
  "/api/entity-components",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    const entityType = String(req.query.entity_type || "country");
    if (!allowedEntityTypes.has(entityType)) {
      return res.status(400).json({ error: "entity_type must be country or company" });
    }
    const entityName = String(req.query.entity_name || (entityType === "country" ? "United States" : "Amazon"));
    const year = toInt(req.query.year, 2030, { min: 2026, max: 2045 });
    const rows = await query(
      `SELECT component_name, tilt_multiplier, component_share, amount_usd_bn
       FROM entity_component_forecast
       WHERE run_id = ? AND entity_type = ? AND entity_name = ? AND year_num = ?
       ORDER BY amount_usd_bn DESC`,
      [runId, entityType, entityName, year],
    );
    res.json({ run_id: runId, entity_type: entityType, entity_name: entityName, year, rows });
  }),
);

app.get(
  "/api/country-company",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    const year = toInt(req.query.year, 2030, { min: 2026, max: 2045 });
    const limit = toInt(req.query.limit, 50, { min: 1, max: 200 });
    const where = ["run_id = ?", "year_num = ?"];
    const params = [runId, year];
    if (req.query.country) {
      where.push("country_name = ?");
      params.push(String(req.query.country));
    }
    if (req.query.company) {
      where.push("company_name = ?");
      params.push(String(req.query.company));
    }
    const rows = await query(
      `SELECT country_name, company_name, prior_share, country_factor, company_factor,
              reconciled_share, allocated_total_usd_bn
       FROM country_company_allocation
       WHERE ${where.join(" AND ")}
       ORDER BY allocated_total_usd_bn DESC
       LIMIT ?`,
      [...params, limit],
    );
    res.json({ run_id: runId, year, rows });
  }),
);

app.get(
  "/api/country-company-components",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    const year = toInt(req.query.year, 2030, { min: 2026, max: 2045 });
    const limit = toInt(req.query.limit, 100, { min: 1, max: 500 });
    const where = ["run_id = ?", "year_num = ?"];
    const params = [runId, year];
    for (const [queryKey, column] of [
      ["country", "country_name"],
      ["company", "company_name"],
      ["component", "component_name"],
    ]) {
      if (req.query[queryKey]) {
        where.push(`${column} = ?`);
        params.push(String(req.query[queryKey]));
      }
    }
    const rows = await query(
      `SELECT country_name, company_name, component_name, amount_usd_bn
       FROM country_company_component_forecast
       WHERE ${where.join(" AND ")}
       ORDER BY amount_usd_bn DESC
       LIMIT ?`,
      [...params, limit],
    );
    res.json({ run_id: runId, year, rows });
  }),
);

app.get(
  "/api/funding",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    const company = String(req.query.company || "Amazon");
    const year = req.query.year ? toInt(req.query.year, 2030, { min: 2026, max: 2045 }) : null;
    const params = [runId, company];
    let yearFilter = "";
    if (year) {
      yearFilter = "AND year_num = ?";
      params.push(year);
    }
    const rows = await query(
      `SELECT company_name, funding_source, year_num, share_of_annual_investment,
              amount_funded_usd_bn, cost_rate, tenor_years, debt_like, cash_interest
       FROM company_funding_terms
       WHERE run_id = ? AND company_name = ? ${yearFilter}
       ORDER BY year_num, amount_funded_usd_bn DESC`,
      params,
    );
    res.json({ run_id: runId, company, year, rows });
  }),
);

app.get(
  "/api/finance",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    const company = String(req.query.company || "Amazon");
    const rows = await query(
      `SELECT *
       FROM company_finance_roic
       WHERE run_id = ? AND company_name = ?
       ORDER BY year_num`,
      [runId, company],
    );
    res.json({ run_id: runId, company, rows });
  }),
);

app.get(
  "/api/sources",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    const limit = toInt(req.query.limit, 100, { min: 1, max: 200 });
    const rows = await query(
      `SELECT source_id, theme, key_fact, url, source_type, notes
       FROM source_register
       WHERE run_id = ?
       ORDER BY source_id + 0, source_id
       LIMIT ?`,
      [runId, limit],
    );
    res.json({ run_id: runId, rows });
  }),
);

function requireRecalculateAccess(req, res) {
  if (process.env.RECALCULATE_ENABLED !== "true") {
    res.status(403).json({ error: "Recalculation API is disabled" });
    return false;
  }
  const token = process.env.RECALCULATE_TOKEN;
  if (token && req.header("x-recalculate-token") !== token) {
    res.status(401).json({ error: "Invalid recalculation token" });
    return false;
  }
  return true;
}

app.get("/api/recalculate/status", (req, res) => {
  res.json({
    enabled: process.env.RECALCULATE_ENABLED === "true",
    running: Boolean(recalculation?.running),
    started_at: recalculation?.started_at || null,
    finished_at: recalculation?.finished_at || null,
    exit_code: recalculation?.exit_code ?? null,
    last_output: recalculation?.last_output || null,
  });
});

app.post(
  "/api/recalculate",
  asyncRoute(async (req, res) => {
    if (!requireRecalculateAccess(req, res)) return;
    if (recalculation?.running) {
      return res.status(409).json({ error: "Recalculation is already running", started_at: recalculation.started_at });
    }

    const pythonBin = process.env.PYTHON_BIN || "python3";
    const scriptPath = path.join(projectRoot, "scripts", "import_aicapex_workbook.py");
    const startedAt = new Date().toISOString();
    recalculation = { running: true, started_at: startedAt, finished_at: null, exit_code: null, last_output: "" };

    const output = [];
    const child = spawn(pythonBin, [scriptPath], {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk) => output.push(chunk.toString()));

    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    const text = output.join("").slice(-12000);
    recalculation = {
      running: false,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: exitCode,
      last_output: text,
    };

    if (exitCode !== 0) {
      return res.status(500).json({ error: "Recalculation failed", output: text });
    }

    const runId = await latestRunId();
    res.json({ ok: true, run_id: runId, output: text });
  }),
);

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "API route not found" });
  }
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((error, req, res, next) => {
  const status = error.status || 500;
  console.error(error);
  res.status(status).json({
    error: status === 500 ? "Internal server error" : error.message,
  });
});

const server = app.listen(port, () => {
  console.log(`AI CapEx Monitor running at http://localhost:${port}`);
});

process.on("SIGTERM", async () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});
