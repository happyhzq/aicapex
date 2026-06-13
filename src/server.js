const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const dotenv = require("dotenv");
const express = require("express");
const mysql = require("mysql2/promise");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const port = Number(process.env.APP_PORT || process.env.PORT || 8788);
const publicDir = path.join(__dirname, "..", "public");
const projectRoot = path.join(__dirname, "..");
const hardwareConfigPath = path.join(projectRoot, "config", "hardware_tracks.json");
const hardwareConfig = JSON.parse(fs.readFileSync(hardwareConfigPath, "utf8"));
let updateJob = null;
let updateConfig = null;
let updateTimer = null;
let nextUpdateAt = null;
let hardwareMarketJob = null;
let hardwareMarketTimer = null;
let nextHardwareMarketRefreshAt = null;
let hardwareMarketCache = { expiresAt: 0, payload: null };

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
const forecastYears = Array.from({ length: 20 }, (_, index) => 2026 + index);
const tierRank = { basic: 1, pro: 2, enterprise: 3, admin: 4 };
const validTiers = new Set(Object.keys(tierRank));
const sessionCookieName = process.env.AUTH_COOKIE_NAME || "aicapex_session";
const sessionTtlSeconds = toInt(process.env.AUTH_SESSION_TTL_SECONDS, 7 * 24 * 60 * 60, {
  min: 60 * 10,
  max: 60 * 60 * 24 * 30,
});

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

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex"), iterations = 310000) {
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, iterationsText, salt, hash] = String(storedHash || "").split("$");
  if (algorithm !== "pbkdf2_sha256" || !iterationsText || !salt || !hash) return false;
  const iterations = Number.parseInt(iterationsText, 10);
  if (!Number.isFinite(iterations)) return false;
  const candidate = crypto.pbkdf2Sync(String(password), salt, iterations, 32, "sha256");
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function publicUser(row) {
  if (!row) return null;
  return {
    user_id: row.user_id,
    email: row.email,
    display_name: row.display_name,
    tier: row.tier,
    capabilities: capabilitiesForTier(row.tier),
  };
}

function capabilitiesForTier(tier) {
  return {
    overview: hasTier(tier, "basic"),
    sources: hasTier(tier, "basic"),
    breakdowns: hasTier(tier, "pro"),
    bridge: hasTier(tier, "pro"),
    finance: hasTier(tier, "pro"),
    hardware: hasTier(tier, "pro"),
    artifacts: hasTier(tier, "enterprise"),
    automation: hasTier(tier, "admin"),
    admin: hasTier(tier, "admin"),
  };
}

function normalizeTier(tier, fallback = "basic") {
  const normalized = String(tier || fallback).toLowerCase();
  return validTiers.has(normalized) ? normalized : fallback;
}

function hasTier(actual, required) {
  return (tierRank[normalizeTier(actual)] || 0) >= (tierRank[required] || 0);
}

function setSessionCookie(res, sessionId) {
  const parts = [
    `${sessionCookieName}=${encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${sessionTtlSeconds}`,
  ];
  if (process.env.AUTH_COOKIE_SECURE === "true") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

async function authUserFromRequest(req) {
  const sessionId = parseCookies(req.headers.cookie)[sessionCookieName];
  if (!sessionId || !/^[a-f0-9]{64}$/i.test(sessionId)) return null;
  const rows = await query(
    `SELECT u.user_id, u.email, u.display_name, u.tier
     FROM app_sessions s
     JOIN app_users u ON u.user_id = s.user_id
     WHERE s.session_id = ? AND s.expires_at > UTC_TIMESTAMP() AND u.active = 1
     LIMIT 1`,
    [sessionId],
  );
  if (!rows.length) return null;
  await query("UPDATE app_sessions SET last_seen_at = UTC_TIMESTAMP() WHERE session_id = ?", [sessionId]);
  req.session_id = sessionId;
  return rows[0];
}

async function authenticateRequest(req, res, next) {
  req.user = await authUserFromRequest(req);
  next();
}

function minimumTierForPath(pathname, method) {
  if (pathname === "/health") return null;
  if (pathname.startsWith("/auth/")) return null;
  if (pathname.startsWith("/update/run") || pathname.startsWith("/update/config")) return "admin";
  if (pathname.startsWith("/recalculate")) return method === "GET" ? "admin" : "admin";
  if (pathname.startsWith("/hardware-market-breadth/refresh")) return "admin";
  if (pathname.startsWith("/update/status")) return "enterprise";
  if (
    pathname.startsWith("/runs") ||
    pathname.startsWith("/artifacts") ||
    pathname.startsWith("/external-sources") ||
    pathname.startsWith("/model-adjustments")
  ) {
    return "enterprise";
  }
  if (
    pathname.startsWith("/entity-components") ||
    pathname.startsWith("/country-company") ||
    pathname.startsWith("/hardware-") ||
    pathname.startsWith("/funding") ||
    pathname.startsWith("/finance")
  ) {
    return "pro";
  }
  return "basic";
}

function enforceApiTier(req, res, next) {
  const required = minimumTierForPath(req.path, req.method);
  if (!required) return next();
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (!hasTier(req.user.tier, required)) {
    return res.status(403).json({ error: `Requires ${required} tier`, required_tier: required });
  }
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function ensureAuthSchema() {
  await query(
    `CREATE TABLE IF NOT EXISTS app_users (
       user_id BIGINT AUTO_INCREMENT PRIMARY KEY,
       email VARCHAR(255) NOT NULL UNIQUE,
       display_name VARCHAR(255),
       password_hash VARCHAR(255) NOT NULL,
       tier VARCHAR(32) NOT NULL DEFAULT 'basic',
       active BOOLEAN NOT NULL DEFAULT TRUE,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       last_login_at TIMESTAMP NULL
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS app_sessions (
       session_id CHAR(64) PRIMARY KEY,
       user_id BIGINT NOT NULL,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       expires_at TIMESTAMP NOT NULL,
       INDEX idx_app_sessions_user (user_id),
       INDEX idx_app_sessions_expires (expires_at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
  await query("DELETE FROM app_sessions WHERE expires_at <= UTC_TIMESTAMP()");
  await bootstrapAuthUser();
}

async function ensureHardwareMarketSchema() {
  await query(
    `CREATE TABLE IF NOT EXISTS hardware_market_snapshots (
       snapshot_date DATE PRIMARY KEY,
       fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       source VARCHAR(128),
       methodology TEXT,
       total_score INT,
       max_score INT,
       track_count INT,
       payload_json LONGTEXT,
       INDEX idx_hardware_market_fetched (fetched_at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS hardware_market_track_snapshots (
       snapshot_date DATE NOT NULL,
       track_id VARCHAR(96) NOT NULL,
       display_name VARCHAR(191),
       short_name VARCHAR(96),
       score INT,
       status VARCHAR(32),
       constituents_total INT,
       priced_constituents INT,
       above_sma20 INT,
       above_sma50 INT,
       pct_above_sma20 DOUBLE,
       pct_above_sma50 DOUBLE,
       avg_return_20d DOUBLE,
       latest_index_level DOUBLE,
       PRIMARY KEY (snapshot_date, track_id),
       INDEX idx_hardware_track_snapshots_track (track_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS hardware_market_constituent_snapshots (
       snapshot_date DATE NOT NULL,
       track_id VARCHAR(96) NOT NULL,
       symbol VARCHAR(32) NOT NULL,
       company_name VARCHAR(191),
       role TEXT,
       weight DOUBLE,
       price_date VARCHAR(10),
       price DOUBLE,
       sma20 DOUBLE,
       sma50 DOUBLE,
       above_sma20 BOOLEAN,
       above_sma50 BOOLEAN,
       return_20d DOUBLE,
       error_message TEXT,
       PRIMARY KEY (snapshot_date, track_id, symbol),
       INDEX idx_hardware_constituent_symbol (symbol)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
}

async function bootstrapAuthUser() {
  const email = process.env.AUTH_BOOTSTRAP_EMAIL || process.env.ADMIN_EMAIL;
  const password = process.env.AUTH_BOOTSTRAP_PASSWORD || process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    const countRows = await query("SELECT COUNT(*) AS user_count FROM app_users");
    if (!countRows[0]?.user_count) {
      console.warn("No auth users exist. Set AUTH_BOOTSTRAP_EMAIL and AUTH_BOOTSTRAP_PASSWORD or run npm run user:create.");
    }
    return;
  }
  const existing = await query("SELECT user_id FROM app_users WHERE email = ? LIMIT 1", [email]);
  if (existing.length) return;
  await query(
    `INSERT INTO app_users (email, display_name, password_hash, tier, active)
     VALUES (?, ?, ?, ?, 1)`,
    [
      email,
      process.env.AUTH_BOOTSTRAP_NAME || "Administrator",
      hashPassword(password),
      normalizeTier(process.env.AUTH_BOOTSTRAP_TIER || "admin", "admin"),
    ],
  );
}

app.post(
  "/api/auth/login",
  asyncRoute(async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

    const rows = await query(
      "SELECT user_id, email, display_name, password_hash, tier, active FROM app_users WHERE email = ? LIMIT 1",
      [email],
    );
    const user = rows[0];
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const sessionId = crypto.randomBytes(32).toString("hex");
    await query(
      `INSERT INTO app_sessions (session_id, user_id, expires_at)
       VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${sessionTtlSeconds} SECOND))`,
      [sessionId, user.user_id],
    );
    await query("UPDATE app_users SET last_login_at = UTC_TIMESTAMP() WHERE user_id = ?", [user.user_id]);
    setSessionCookie(res, sessionId);
    res.json({ user: publicUser(user) });
  }),
);

app.post(
  "/api/auth/logout",
  asyncRoute(async (req, res) => {
    const sessionId = parseCookies(req.headers.cookie)[sessionCookieName];
    if (sessionId) await query("DELETE FROM app_sessions WHERE session_id = ?", [sessionId]);
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

app.get(
  "/api/auth/me",
  asyncRoute(async (req, res) => {
    const user = await authUserFromRequest(req);
    res.json({ user: publicUser(user), tiers: Object.keys(tierRank) });
  }),
);

app.use("/api", asyncRoute(authenticateRequest), enforceApiTier);

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

function missingTable(error) {
  return error?.code === "ER_NO_SUCH_TABLE" || /doesn't exist/i.test(String(error?.message || ""));
}

function missingColumn(error) {
  return error?.code === "ER_BAD_FIELD_ERROR" || /Unknown column/i.test(String(error?.message || ""));
}

app.get(
  "/api/artifacts",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    try {
      const rows = await query(
        `SELECT run_id, pipeline_id, source_workbook_path, generated_workbook_path,
                source_snapshot_path, adjustment_path, manifest_path, generated_at, import_trigger
         FROM model_run_artifacts
         WHERE run_id = ?`,
        [runId],
      );
      res.json({ run_id: runId, artifact: rows[0] || null });
    } catch (error) {
      if (missingTable(error)) return res.json({ run_id: runId, artifact: null });
      throw error;
    }
  }),
);

app.get(
  "/api/external-sources",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    try {
      const rows = await query(
        `SELECT source_id, source_name, source_type, signal_name, status, fetched_at,
                latest_date, latest_value, yoy, row_count, url, raw_path, parsed_path, error_message,
                metadata_json
         FROM external_source_observations
         WHERE run_id = ?
         ORDER BY source_id`,
        [runId],
      );
      res.json({ run_id: runId, rows });
    } catch (error) {
      if (missingTable(error)) return res.json({ run_id: runId, rows: [] });
      if (missingColumn(error)) {
        const rows = await query(
          `SELECT source_id, source_name, source_type, signal_name, status, fetched_at,
                  latest_date, latest_value, yoy, row_count, url, raw_path, parsed_path, error_message,
                  NULL AS metadata_json
           FROM external_source_observations
           WHERE run_id = ?
           ORDER BY source_id`,
          [runId],
        );
        return res.json({ run_id: runId, rows });
      }
      throw error;
    }
  }),
);

app.get(
  "/api/model-adjustments",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    const limit = toInt(req.query.limit, 120, { min: 1, max: 500 });
    try {
      const rows = await query(
        `SELECT driver_name, year_num, baseline_contribution, adjusted_contribution,
                delta_contribution, signal_name, rationale
         FROM model_driver_adjustments
         WHERE run_id = ?
         ORDER BY driver_name, year_num
         LIMIT ?`,
        [runId, limit],
      );
      res.json({ run_id: runId, rows });
    } catch (error) {
      if (missingTable(error)) return res.json({ run_id: runId, rows: [] });
      throw error;
    }
  }),
);

function anchorValue(item, year) {
  const y = Number(year);
  const start = Number(item.target_2026 || 0);
  const mid = Number(item.target_2030 || start);
  const end = Number(item.target_2045 || mid);
  if (y <= 2030) return start + ((mid - start) * (y - 2026)) / 4;
  return mid + ((end - mid) * (y - 2030)) / 15;
}

function uniqueHardwareComponents() {
  const names = new Set();
  for (const track of hardwareConfig.tracks || []) {
    for (const component of track.components || []) names.add(component.component_name);
  }
  for (const component of hardwareConfig.optical_split?.source_components || []) names.add(component.component_name);
  return [...names];
}

async function componentAmounts(runId, componentNames) {
  if (!componentNames.length) return [];
  return query(
    `SELECT item_name, year_num, share_of_global, amount_usd_bn
     FROM forecast_totals
     WHERE run_id = ? AND dimension_name = 'component'
       AND item_name IN (${placeholders(componentNames)})
     ORDER BY item_name, year_num`,
    [runId, ...componentNames],
  );
}

async function allComponentAmounts(runId) {
  return query(
    `SELECT item_name, year_num, share_of_global, amount_usd_bn
     FROM forecast_totals
     WHERE run_id = ? AND dimension_name = 'component'
     ORDER BY year_num, amount_usd_bn DESC`,
    [runId],
  );
}

async function globalAmounts(runId) {
  const rows = await query(
    `SELECT year_num, total_usd_bn
     FROM global_forecast
     WHERE run_id = ?
     ORDER BY year_num`,
    [runId],
  );
  return new Map(rows.map((row) => [row.year_num, Number(row.total_usd_bn || 0)]));
}

function mapComponentRows(rows) {
  const out = new Map();
  for (const row of rows) {
    if (!out.has(row.item_name)) out.set(row.item_name, new Map());
    out.get(row.item_name).set(row.year_num, Number(row.amount_usd_bn || 0));
  }
  return out;
}

function opticalForecastFromComponents(componentMap, globalByYear) {
  const sourceComponents = hardwareConfig.optical_split?.source_components || [];
  const categories = hardwareConfig.optical_split?.categories || [];
  const sourceRows = [];
  const categoryRows = [];
  const totalByYear = new Map();

  for (const year of forecastYears) {
    let opticalTotal = 0;
    for (const source of sourceComponents) {
      const sourceAmount = Number(componentMap.get(source.component_name)?.get(year) || 0);
      const opticalShare = anchorValue(source, year);
      const opticalAmount = sourceAmount * opticalShare;
      opticalTotal += opticalAmount;
      sourceRows.push({
        component_name: source.component_name,
        year_num: year,
        source_amount_usd_bn: sourceAmount,
        optical_share: opticalShare,
        optical_amount_usd_bn: opticalAmount,
        source_logic: source.source_logic,
      });
    }
    totalByYear.set(year, opticalTotal);

    const categoryShareSum = categories.reduce((sum, category) => sum + anchorValue(category, year), 0) || 1;
    const globalAmount = Number(globalByYear.get(year) || 0);
    for (const category of categories) {
      const normalizedShare = anchorValue(category, year) / categoryShareSum;
      const amount = opticalTotal * normalizedShare;
      categoryRows.push({
        category_id: category.category_id,
        display_name: category.display_name,
        year_num: year,
        category_share: normalizedShare,
        amount_usd_bn: amount,
        share_of_global: globalAmount ? amount / globalAmount : 0,
        source_logic: category.source_logic,
      });
    }
  }

  return { sourceRows, categoryRows, totalByYear };
}

function capexSplitViews(componentRows, componentMap, optical, globalByYear, year) {
  const allRows = componentRows
    .filter((row) => row.year_num === year)
    .map((row) => ({
      item_id: row.item_name,
      display_name: row.item_name,
      year_num: year,
      amount_usd_bn: Number(row.amount_usd_bn || 0),
      split_share: Number(row.share_of_global || 0),
      share_of_global: Number(row.share_of_global || 0),
      basis: "Global component forecast",
    }))
    .sort((a, b) => b.amount_usd_bn - a.amount_usd_bn);

  const views = [
    {
      split_id: "all_components",
      display_name: "All CapEx components",
      total_usd_bn: allRows.reduce((sum, row) => sum + row.amount_usd_bn, 0),
      rows: allRows,
    },
  ];

  for (const track of hardwareConfig.tracks || []) {
    if (track.optical_derived) {
      const rows = optical.categoryRows
        .filter((row) => row.year_num === year)
        .map((row) => ({
          item_id: row.category_id,
          display_name: row.display_name,
          year_num: year,
          amount_usd_bn: Number(row.amount_usd_bn || 0),
          split_share: Number(row.category_share || 0),
          share_of_global: Number(row.share_of_global || 0),
          basis: row.source_logic,
        }))
        .sort((a, b) => b.amount_usd_bn - a.amount_usd_bn);
      views.push({
        split_id: track.track_id,
        display_name: track.display_name,
        total_usd_bn: Number(optical.totalByYear.get(year) || 0),
        rows,
      });
      continue;
    }

    const weightedRows = (track.components || [])
      .map((component) => {
        const componentAmount = Number(componentMap.get(component.component_name)?.get(year) || 0);
        const weight = Number(component.weight || 1);
        const amount = componentAmount * weight;
        const globalAmount = Number(globalByYear.get(year) || 0);
        return {
          item_id: component.component_name,
          display_name: component.component_name,
          year_num: year,
          amount_usd_bn: amount,
          split_share: 0,
          share_of_global: globalAmount ? amount / globalAmount : 0,
          basis: weight === 1 ? "Track source component" : `Track source component at ${weight.toFixed(2)}x weight`,
        };
      })
      .filter((row) => row.amount_usd_bn > 0);
    const total = weightedRows.reduce((sum, row) => sum + row.amount_usd_bn, 0);
    const rows = weightedRows
      .map((row) => ({ ...row, split_share: total ? row.amount_usd_bn / total : 0 }))
      .sort((a, b) => b.amount_usd_bn - a.amount_usd_bn);
    views.push({
      split_id: track.track_id,
      display_name: track.display_name,
      total_usd_bn: total,
      rows,
    });
  }

  return views;
}

async function hardwareDashboardPayload(runId, year) {
  const components = uniqueHardwareComponents();
  const [componentRows, allComponents, globalByYear] = await Promise.all([
    componentAmounts(runId, components),
    allComponentAmounts(runId),
    globalAmounts(runId),
  ]);
  const componentMap = mapComponentRows(componentRows);
  const optical = opticalForecastFromComponents(componentMap, globalByYear);
  const splits = capexSplitViews(allComponents, componentMap, optical, globalByYear, year);
  const trackSeries = [];
  const selectedTracks = [];

  for (const track of hardwareConfig.tracks || []) {
    for (const yearNum of forecastYears) {
      let amount = 0;
      if (track.optical_derived) {
        amount = Number(optical.totalByYear.get(yearNum) || 0);
      } else {
        for (const component of track.components || []) {
          amount += Number(componentMap.get(component.component_name)?.get(yearNum) || 0) * Number(component.weight || 1);
        }
      }
      const globalAmount = Number(globalByYear.get(yearNum) || 0);
      const row = {
        track_id: track.track_id,
        display_name: track.display_name,
        short_name: track.short_name,
        year_num: yearNum,
        amount_usd_bn: amount,
        share_of_global: globalAmount ? amount / globalAmount : 0,
      };
      trackSeries.push(row);
      if (yearNum === year) selectedTracks.push(row);
    }
  }

  selectedTracks.sort((a, b) => b.amount_usd_bn - a.amount_usd_bn);
  const selectedOpticalCategories = optical.categoryRows
    .filter((row) => row.year_num === year)
    .sort((a, b) => b.amount_usd_bn - a.amount_usd_bn);
  const selectedOpticalSources = optical.sourceRows
    .filter((row) => row.year_num === year)
    .sort((a, b) => b.optical_amount_usd_bn - a.optical_amount_usd_bn);

  return {
    run_id: runId,
    year,
    methodology: {
      hardware_tracks: "Track capex exposure is derived from the model component forecast using configured component weights. Tracks are analytical exposure baskets and are not intended to sum to global capex.",
      optical_split: hardwareConfig.optical_split?.methodology,
    },
    tracks: selectedTracks,
    track_series: trackSeries,
    optical: {
      total_usd_bn: Number(optical.totalByYear.get(year) || 0),
      categories: selectedOpticalCategories,
      source_components: selectedOpticalSources,
      series: optical.categoryRows,
    },
    capex_splits: splits,
    definitions: hardwareConfig.tracks,
  };
}

function movingAverage(values, window) {
  if (values.length < window) return null;
  const slice = values.slice(-window);
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

async function fetchYahooHistory(symbol) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "aicapex-monitor/0.1" },
    });
    if (!response.ok) throw new Error(`Yahoo chart ${response.status}`);
    const body = await response.json();
    const result = body?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const rows = timestamps
      .map((stamp, index) => ({
        date: new Date(stamp * 1000).toISOString().slice(0, 10),
        close: Number(closes[index]),
      }))
      .filter((row) => Number.isFinite(row.close) && row.close > 0);
    if (rows.length < 20) throw new Error("Not enough price history");
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

function summarizeHistory(constituent, history) {
  const closes = history.map((row) => row.close);
  const last = closes[closes.length - 1];
  const previous20 = closes.length > 20 ? closes[closes.length - 21] : null;
  const sma20 = movingAverage(closes, 20);
  const sma50 = movingAverage(closes, 50);
  return {
    ...constituent,
    as_of: history[history.length - 1].date,
    price: last,
    sma20,
    sma50,
    above_sma20: sma20 === null ? null : last > sma20,
    above_sma50: sma50 === null ? null : last > sma50,
    return_20d: previous20 ? last / previous20 - 1 : null,
    history,
  };
}

function buildTrackIndexSeries(constituents) {
  const normalized = constituents
    .filter((item) => item.history?.length >= 20)
    .map((item) => {
      const rows = item.history.slice(-60);
      const base = rows[0]?.close || 0;
      return {
        weight: Number(item.weight || 0),
        rows: base ? rows.map((row) => ({ date: row.date, value: (row.close / base) * 100 })) : [],
      };
    })
    .filter((item) => item.rows.length);
  if (!normalized.length) return [];

  const maxLength = Math.max(...normalized.map((item) => item.rows.length));
  const series = [];
  for (let index = 0; index < maxLength; index += 1) {
    let weighted = 0;
    let weightSum = 0;
    let date = null;
    for (const item of normalized) {
      const row = item.rows[item.rows.length - maxLength + index];
      if (!row) continue;
      weighted += row.value * item.weight;
      weightSum += item.weight;
      date = row.date;
    }
    if (weightSum && date) series.push({ date, index_level: weighted / weightSum });
  }
  return series;
}

function buildConstituentSignalRows(constituent) {
  if (!constituent.history?.length) return [];
  const rows = [];
  for (let index = 19; index < constituent.history.length; index += 1) {
    const windowRows = constituent.history.slice(index - 19, index + 1);
    const sma20 = windowRows.reduce((sum, row) => sum + Number(row.close || 0), 0) / windowRows.length;
    const close = Number(constituent.history[index].close || 0);
    if (!Number.isFinite(close) || !Number.isFinite(sma20) || !sma20) continue;
    rows.push({
      date: constituent.history[index].date,
      above_sma20: close > sma20,
    });
  }
  return rows.slice(-80);
}

function buildTrackBreadthHistory(constituents) {
  const byDate = new Map();
  for (const constituent of constituents) {
    for (const row of buildConstituentSignalRows(constituent)) {
      if (!byDate.has(row.date)) byDate.set(row.date, { date: row.date, priced_constituents: 0, above_sma20: 0 });
      const entry = byDate.get(row.date);
      entry.priced_constituents += 1;
      if (row.above_sma20) entry.above_sma20 += 1;
    }
  }
  return [...byDate.values()]
    .filter((row) => row.priced_constituents > 0)
    .map((row) => ({
      ...row,
      score: Math.round((row.above_sma20 / row.priced_constituents) * 100),
    }))
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-60);
}

function buildBreadthHistoryTable(tracks) {
  const minimumMaxScore = Math.max(100, Math.ceil(tracks.length * 0.5) * 100);
  const trackMaps = new Map(
    tracks.map((track) => [track.track_id, new Map((track.breadth_history || []).map((row) => [row.date, row]))]),
  );
  const dates = [
    ...new Set(
      tracks.flatMap((track) => (track.breadth_history || []).map((row) => row.date)),
    ),
  ]
    .sort((left, right) => right.localeCompare(left))
    .slice(0, 60);

  return dates
    .map((date) => {
      const scores = {};
      let totalScore = 0;
      let maxScore = 0;
      for (const track of tracks) {
        const row = trackMaps.get(track.track_id)?.get(date);
        if (!row || typeof row.score !== "number") {
          scores[track.track_id] = null;
          continue;
        }
        scores[track.track_id] = row.score;
        totalScore += row.score;
        maxScore += 100;
      }
      return { date, total_score: totalScore, max_score: maxScore, scores };
    })
    .filter((row) => row.max_score >= minimumMaxScore);
}

function sqlDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function statusForScore(score) {
  if (score === null || score === undefined) return "unavailable";
  return score >= 70 ? "strong" : score >= 50 ? "mixed" : "weak";
}

function latestCompleteBreadthDate(payload) {
  return payload.breadth_history?.[0]?.date || null;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function computeHardwareMarketBreadthPayload() {
  const bySymbol = new Map();
  for (const track of hardwareConfig.tracks || []) {
    for (const constituent of track.constituents || []) {
      if (!bySymbol.has(constituent.symbol)) bySymbol.set(constituent.symbol, constituent);
    }
  }

  const fetched = await mapLimit([...bySymbol.values()], 5, async (constituent) => {
    try {
      const history = await fetchYahooHistory(constituent.symbol);
      return summarizeHistory(constituent, history);
    } catch (error) {
      return { ...constituent, error: error.message };
    }
  });
  const fetchedBySymbol = new Map(fetched.map((item) => [item.symbol, item]));

  const tracks = (hardwareConfig.tracks || []).map((track) => {
    const constituents = (track.constituents || []).map((item) => fetchedBySymbol.get(item.symbol) || item);
    const valid20 = constituents.filter((item) => item.above_sma20 !== null && item.above_sma20 !== undefined);
    const valid50 = constituents.filter((item) => item.above_sma50 !== null && item.above_sma50 !== undefined);
    const above20 = valid20.filter((item) => item.above_sma20).length;
    const above50 = valid50.filter((item) => item.above_sma50).length;
    const weightedReturnRows = constituents.filter((item) => typeof item.return_20d === "number" && Number.isFinite(item.return_20d));
    const weightSum = weightedReturnRows.reduce((sum, item) => sum + Number(item.weight || 0), 0) || 1;
    const avgReturn20d =
      weightedReturnRows.reduce((sum, item) => sum + Number(item.return_20d || 0) * Number(item.weight || 0), 0) / weightSum;
    const score = valid20.length ? Math.round((above20 / valid20.length) * 100) : null;
    const status = score === null ? "unavailable" : score >= 70 ? "strong" : score >= 50 ? "mixed" : "weak";
    const series = buildTrackIndexSeries(constituents);
    const breadthHistory = buildTrackBreadthHistory(constituents);
    return {
      track_id: track.track_id,
      display_name: track.display_name,
      short_name: track.short_name,
      description: track.description,
      score,
      status,
      constituents_total: track.constituents?.length || 0,
      priced_constituents: valid20.length,
      above_sma20: above20,
      above_sma50: above50,
      pct_above_sma20: valid20.length ? above20 / valid20.length : null,
      pct_above_sma50: valid50.length ? above50 / valid50.length : null,
      avg_return_20d: Number.isFinite(avgReturn20d) ? avgReturn20d : null,
      latest_index_level: series.length ? series[series.length - 1].index_level : null,
      index_series: series,
      breadth_history: breadthHistory,
      constituents: constituents.map(({ history, ...item }) => item),
    };
  });

  const scoredTracks = tracks.filter((track) => typeof track.score === "number");
  const breadthHistory = buildBreadthHistoryTable(tracks);
  const payload = {
    as_of: new Date().toISOString(),
    source: "Yahoo Finance chart endpoint",
    methodology:
      "Equal-basket breadth by hardware track. A constituent is counted as positive breadth when its latest close is above its own 20-day SMA; 50-day breadth is shown as confirmation.",
    total_score: scoredTracks.reduce((sum, track) => sum + track.score, 0),
    max_score: scoredTracks.length * 100,
    breadth_history: breadthHistory,
    tracks,
    cached: false,
  };
  return payload;
}

async function saveHardwareMarketSnapshot(payload, trigger = "manual") {
  const snapshotDate = latestCompleteBreadthDate(payload);
  if (!snapshotDate) {
    const error = new Error("No complete hardware market breadth date available to persist");
    error.status = 502;
    throw error;
  }
  const latestHistory = payload.breadth_history[0];
  const payloadForStorage = {
    ...payload,
    snapshot_date: snapshotDate,
    refresh_trigger: trigger,
  };

  await query(
    `INSERT INTO hardware_market_snapshots
       (snapshot_date, fetched_at, source, methodology, total_score, max_score, track_count, payload_json)
     VALUES (?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       fetched_at = VALUES(fetched_at),
       source = VALUES(source),
       methodology = VALUES(methodology),
       total_score = VALUES(total_score),
       max_score = VALUES(max_score),
       track_count = VALUES(track_count),
       payload_json = VALUES(payload_json)`,
    [
      snapshotDate,
      payload.source,
      payload.methodology,
      latestHistory.total_score,
      latestHistory.max_score,
      payload.tracks.length,
      JSON.stringify(payloadForStorage),
    ],
  );

  for (const track of payload.tracks || []) {
    const historyRow = (track.breadth_history || []).find((row) => row.date === snapshotDate);
    const score = historyRow?.score ?? track.score;
    await query(
      `INSERT INTO hardware_market_track_snapshots
         (snapshot_date, track_id, display_name, short_name, score, status, constituents_total,
          priced_constituents, above_sma20, above_sma50, pct_above_sma20, pct_above_sma50,
          avg_return_20d, latest_index_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name),
         short_name = VALUES(short_name),
         score = VALUES(score),
         status = VALUES(status),
         constituents_total = VALUES(constituents_total),
         priced_constituents = VALUES(priced_constituents),
         above_sma20 = VALUES(above_sma20),
         above_sma50 = VALUES(above_sma50),
         pct_above_sma20 = VALUES(pct_above_sma20),
         pct_above_sma50 = VALUES(pct_above_sma50),
         avg_return_20d = VALUES(avg_return_20d),
         latest_index_level = VALUES(latest_index_level)`,
      [
        snapshotDate,
        track.track_id,
        track.display_name,
        track.short_name,
        score,
        statusForScore(score),
        track.constituents_total,
        historyRow?.priced_constituents ?? track.priced_constituents,
        historyRow?.above_sma20 ?? track.above_sma20,
        track.above_sma50,
        historyRow?.priced_constituents ? historyRow.above_sma20 / historyRow.priced_constituents : track.pct_above_sma20,
        track.pct_above_sma50,
        track.avg_return_20d,
        track.latest_index_level,
      ],
    );

    for (const constituent of track.constituents || []) {
      await query(
        `INSERT INTO hardware_market_constituent_snapshots
           (snapshot_date, track_id, symbol, company_name, role, weight, price_date, price,
            sma20, sma50, above_sma20, above_sma50, return_20d, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           company_name = VALUES(company_name),
           role = VALUES(role),
           weight = VALUES(weight),
           price_date = VALUES(price_date),
           price = VALUES(price),
           sma20 = VALUES(sma20),
           sma50 = VALUES(sma50),
           above_sma20 = VALUES(above_sma20),
           above_sma50 = VALUES(above_sma50),
           return_20d = VALUES(return_20d),
           error_message = VALUES(error_message)`,
        [
          snapshotDate,
          track.track_id,
          constituent.symbol,
          constituent.company_name,
          constituent.role,
          constituent.weight,
          constituent.as_of || null,
          constituent.price ?? null,
          constituent.sma20 ?? null,
          constituent.sma50 ?? null,
          constituent.above_sma20 ?? null,
          constituent.above_sma50 ?? null,
          constituent.return_20d ?? null,
          constituent.error || null,
        ],
      );
    }
  }

  return snapshotDate;
}

async function loadHardwareMarketSnapshotPayload(limit = 60) {
  let snapshots;
  try {
    snapshots = await query(
      `SELECT snapshot_date, fetched_at, source, methodology, total_score, max_score, track_count, payload_json
       FROM hardware_market_snapshots
       ORDER BY snapshot_date DESC
       LIMIT ?`,
      [limit],
    );
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
  if (!snapshots.length) return null;

  const latest = snapshots[0];
  const dates = snapshots.map((row) => sqlDate(row.snapshot_date)).filter(Boolean);
  const trackRows = dates.length
    ? await query(
        `SELECT snapshot_date, track_id, score, status, constituents_total, priced_constituents,
                above_sma20, above_sma50, pct_above_sma20, pct_above_sma50,
                avg_return_20d, latest_index_level
         FROM hardware_market_track_snapshots
         WHERE snapshot_date IN (${placeholders(dates)})
         ORDER BY snapshot_date DESC, track_id`,
        dates,
      )
    : [];

  const trackRowsByDate = new Map();
  for (const row of trackRows) {
    const date = sqlDate(row.snapshot_date);
    if (!trackRowsByDate.has(date)) trackRowsByDate.set(date, new Map());
    trackRowsByDate.get(date).set(row.track_id, row);
  }

  let payload = {};
  try {
    payload = JSON.parse(latest.payload_json || "{}");
  } catch {
    payload = {};
  }
  const trackIds = (payload.tracks || hardwareConfig.tracks || []).map((track) => track.track_id);
  const breadthHistory = snapshots.map((snapshot) => {
    const date = sqlDate(snapshot.snapshot_date);
    const scores = {};
    for (const trackId of trackIds) {
      const score = trackRowsByDate.get(date)?.get(trackId)?.score;
      scores[trackId] = score === undefined ? null : score;
    }
    return {
      date,
      total_score: Number(snapshot.total_score || 0),
      max_score: Number(snapshot.max_score || 0),
      scores,
    };
  });

  const latestDate = sqlDate(latest.snapshot_date);
  const latestTrackRows = trackRowsByDate.get(latestDate) || new Map();
  const tracks = (payload.tracks || []).map((track) => {
    const row = latestTrackRows.get(track.track_id);
    if (!row) return track;
    return {
      ...track,
      score: row.score,
      status: row.status,
      constituents_total: row.constituents_total,
      priced_constituents: row.priced_constituents,
      above_sma20: row.above_sma20,
      above_sma50: row.above_sma50,
      pct_above_sma20: row.pct_above_sma20,
      pct_above_sma50: row.pct_above_sma50,
      avg_return_20d: row.avg_return_20d,
      latest_index_level: row.latest_index_level,
    };
  });

  return {
    ...payload,
    as_of: latest.fetched_at instanceof Date ? latest.fetched_at.toISOString() : String(latest.fetched_at),
    source: latest.source || payload.source,
    total_score: Number(latest.total_score || 0),
    max_score: Number(latest.max_score || 0),
    breadth_history: breadthHistory,
    tracks,
    cached: false,
    persisted: true,
    snapshot_date: latestDate,
    next_refresh_at: nextHardwareMarketRefreshAt,
    refresh_schedule: "Asia/Shanghai daily 06:30",
  };
}

async function hardwareMarketBreadthPayload({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && hardwareMarketCache.payload && hardwareMarketCache.expiresAt > now) {
    return { ...hardwareMarketCache.payload, cached: true };
  }

  if (!refresh) {
    const persisted = await loadHardwareMarketSnapshotPayload();
    if (persisted) {
      hardwareMarketCache = { expiresAt: now + 30 * 60 * 1000, payload: persisted };
      return persisted;
    }
  }

  const computed = await computeHardwareMarketBreadthPayload();
  const snapshotDate = await saveHardwareMarketSnapshot(computed, refresh ? "manual" : "fallback");
  const persisted = (await loadHardwareMarketSnapshotPayload()) || { ...computed, snapshot_date: snapshotDate };
  hardwareMarketCache = { expiresAt: now + 30 * 60 * 1000, payload: persisted };
  return persisted;
}

async function runHardwareMarketRefresh(trigger = "manual") {
  if (hardwareMarketJob?.running) {
    const error = new Error("Hardware market refresh is already running");
    error.status = 409;
    throw error;
  }

  hardwareMarketJob = {
    running: true,
    trigger,
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    snapshot_date: null,
  };

  try {
    const computed = await computeHardwareMarketBreadthPayload();
    const snapshotDate = await saveHardwareMarketSnapshot(computed, trigger);
    const persisted = (await loadHardwareMarketSnapshotPayload()) || computed;
    hardwareMarketCache = { expiresAt: Date.now() + 30 * 60 * 1000, payload: persisted };
    hardwareMarketJob = {
      ...hardwareMarketJob,
      running: false,
      finished_at: new Date().toISOString(),
      snapshot_date: snapshotDate,
    };
    return { ok: true, snapshot_date: snapshotDate, job: hardwareMarketJob };
  } catch (error) {
    hardwareMarketJob = {
      ...hardwareMarketJob,
      running: false,
      finished_at: new Date().toISOString(),
      error: error.message,
    };
    throw error;
  }
}

function beijingParts(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

function beijingWallClockUtc(parts, hour, minute) {
  return new Date(Date.UTC(parts.year, parts.month, parts.day, hour - 8, minute, 0, 0));
}

function nextBeijingDailyDelayMs(timeText = "06:30") {
  const match = /^(\d{2}):(\d{2})$/.exec(String(timeText || ""));
  const hour = match ? toInt(match[1], 6, { min: 0, max: 23 }) : 6;
  const minute = match ? toInt(match[2], 30, { min: 0, max: 59 }) : 30;
  const now = new Date();
  const today = beijingParts(now);
  let next = beijingWallClockUtc(today, hour, minute);
  if (next <= now) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
  return Math.max(1000, next.getTime() - now.getTime());
}

function clearHardwareMarketTimer() {
  if (hardwareMarketTimer) clearTimeout(hardwareMarketTimer);
  hardwareMarketTimer = null;
  nextHardwareMarketRefreshAt = null;
}

function scheduleHardwareMarketRefresh() {
  clearHardwareMarketTimer();
  if (!envBool("HARDWARE_MARKET_AUTO_REFRESH_ENABLED", true)) return;

  const timeText = process.env.HARDWARE_MARKET_REFRESH_TIME || "06:30";
  const waitMs = nextBeijingDailyDelayMs(timeText);
  nextHardwareMarketRefreshAt = new Date(Date.now() + waitMs).toISOString();
  hardwareMarketTimer = setTimeout(async () => {
    try {
      await runHardwareMarketRefresh("schedule");
    } catch (error) {
      console.error("Scheduled hardware market refresh failed:", error);
    } finally {
      scheduleHardwareMarketRefresh();
    }
  }, waitMs);
}

async function seedHardwareMarketSnapshotIfEmpty() {
  if (!envBool("HARDWARE_MARKET_SEED_ON_START", true)) return;
  const rows = await query("SELECT COUNT(*) AS snapshot_count FROM hardware_market_snapshots");
  if (Number(rows[0]?.snapshot_count || 0) > 0) return;
  try {
    await runHardwareMarketRefresh("startup-empty");
  } catch (error) {
    console.error("Initial hardware market snapshot failed:", error);
  }
}

app.get(
  "/api/hardware-dashboard",
  asyncRoute(async (req, res) => {
    const runId = await resolveRunId(req);
    const year = toInt(req.query.year, 2030, { min: 2026, max: 2045 });
    res.json(await hardwareDashboardPayload(runId, year));
  }),
);

app.get(
  "/api/hardware-market-breadth",
  asyncRoute(async (req, res) => {
    res.json(await hardwareMarketBreadthPayload());
  }),
);

app.get(
  "/api/hardware-market-breadth/status",
  asyncRoute(async (req, res) => {
    const latest = await loadHardwareMarketSnapshotPayload(1);
    res.json({
      auto_refresh_enabled: envBool("HARDWARE_MARKET_AUTO_REFRESH_ENABLED", true),
      refresh_schedule: "Asia/Shanghai daily 06:30",
      refresh_time: process.env.HARDWARE_MARKET_REFRESH_TIME || "06:30",
      next_refresh_at: nextHardwareMarketRefreshAt,
      running: Boolean(hardwareMarketJob?.running),
      job: hardwareMarketJob,
      latest_snapshot: latest
        ? {
            snapshot_date: latest.snapshot_date,
            as_of: latest.as_of,
            total_score: latest.total_score,
            max_score: latest.max_score,
          }
        : null,
    });
  }),
);

app.post(
  "/api/hardware-market-breadth/refresh",
  asyncRoute(async (req, res) => {
    const result = await runHardwareMarketRefresh("manual");
    res.json(result);
  }),
);

const updateModes = {
  workbook: {
    label: "Scheme A - Excel import",
    detail: "Reload the configured workbook into MySQL as a new model run.",
  },
  pipeline: {
    label: "Scheme B - Dynamic pipeline",
    detail: "Run the dynamic pipeline command, then publish the recalculated model run.",
  },
};

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function updateConfigPath() {
  return path.resolve(projectRoot, process.env.UPDATE_CONFIG_PATH || path.join("tmp", "update-config.json"));
}

function normalizeUpdateMode(mode) {
  const normalized = String(mode || "workbook").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(updateModes, normalized)) {
    const error = new Error("Update mode must be workbook or pipeline");
    error.status = 400;
    throw error;
  }
  return normalized;
}

function normalizeUpdateConfig(input = {}) {
  return {
    enabled: Boolean(input.enabled),
    mode: normalizeUpdateMode(input.mode || "workbook"),
    schedule_type: ["interval", "weekly"].includes(String(input.schedule_type || "interval"))
      ? String(input.schedule_type || "interval")
      : "interval",
    interval_hours: toInt(input.interval_hours, 24, { min: 1, max: 168 }),
    weekly_day: toInt(input.weekly_day, 0, { min: 0, max: 6 }),
    weekly_time: /^\d{2}:\d{2}$/.test(String(input.weekly_time || "")) ? String(input.weekly_time) : "00:00",
    run_on_start: Boolean(input.run_on_start),
  };
}

function defaultUpdateConfig() {
  return normalizeUpdateConfig({
    enabled: envBool("AUTO_UPDATE_ENABLED", false),
    mode: process.env.AUTO_UPDATE_MODE || "workbook",
    schedule_type: process.env.AUTO_UPDATE_SCHEDULE_TYPE || "interval",
    interval_hours: process.env.AUTO_UPDATE_INTERVAL_HOURS || 24,
    weekly_day: process.env.AUTO_UPDATE_WEEKLY_DAY || 0,
    weekly_time: process.env.AUTO_UPDATE_WEEKLY_TIME || "00:00",
    run_on_start: envBool("AUTO_UPDATE_RUN_ON_START", false),
  });
}

function loadUpdateConfig() {
  const defaults = defaultUpdateConfig();
  const configFile = updateConfigPath();
  if (!fs.existsSync(configFile)) return defaults;
  try {
    const persisted = JSON.parse(fs.readFileSync(configFile, "utf8"));
    return normalizeUpdateConfig({ ...defaults, ...persisted });
  } catch (error) {
    console.error(`Failed to read update config from ${configFile}:`, error);
    return defaults;
  }
}

function saveUpdateConfig(config) {
  const configFile = updateConfigPath();
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function updateCommand(mode) {
  const pythonBin = process.env.PYTHON_BIN || "python3";
  if (mode === "workbook") {
    return {
      command: pythonBin,
      args: [path.join(projectRoot, "scripts", "import_aicapex_workbook.py")],
      shell: false,
    };
  }

  if (process.env.PIPELINE_UPDATE_COMMAND) {
    return {
      command: process.env.PIPELINE_UPDATE_COMMAND,
      args: [],
      shell: true,
    };
  }

  return {
    command: pythonBin,
    args: [path.join(projectRoot, "scripts", "run_dynamic_pipeline.py")],
    shell: false,
  };
}

function updateStatusPayload() {
  return {
    access_enabled: process.env.RECALCULATE_ENABLED === "true",
    modes: Object.entries(updateModes).map(([id, item]) => ({ id, ...item })),
    config: updateConfig,
    next_run_at: nextUpdateAt,
    running: Boolean(updateJob?.running),
    started_at: updateJob?.started_at || null,
    finished_at: updateJob?.finished_at || null,
    exit_code: updateJob?.exit_code ?? null,
    mode: updateJob?.mode || null,
    trigger: updateJob?.trigger || null,
    last_output: updateJob?.last_output || null,
  };
}

async function runUpdate(mode, trigger = "manual") {
  const selectedMode = normalizeUpdateMode(mode || updateConfig.mode);
  if (updateJob?.running) {
    const error = new Error("Update job is already running");
    error.status = 409;
    throw error;
  }

  const command = updateCommand(selectedMode);
  const startedAt = new Date().toISOString();
  updateJob = {
    running: true,
    mode: selectedMode,
    trigger,
    started_at: startedAt,
    finished_at: null,
    exit_code: null,
    last_output: "",
  };

  const output = [];
  const child = spawn(command.command, command.args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      AUTO_UPDATE_MODE: selectedMode,
      AUTO_UPDATE_TRIGGER: trigger,
    },
    shell: command.shell,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  const exitCode = await new Promise((resolve) => {
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      resolve(code);
    };
    child.on("error", (error) => {
      output.push(`\n${error.stack || error.message}\n`);
      finish(127);
    });
    child.on("close", finish);
  });

  const text = output.join("").slice(-12000);
  updateJob = {
    running: false,
    mode: selectedMode,
    trigger,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: exitCode,
    last_output: text,
  };

  if (exitCode !== 0) {
    const error = new Error("Update job failed");
    error.status = 500;
    error.output = text;
    throw error;
  }

  const runId = await latestRunId();
  return { ok: true, run_id: runId, job: updateJob };
}

function clearAutoUpdateTimer() {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = null;
  nextUpdateAt = null;
}

function scheduleAutoUpdate(delayMs = null) {
  clearAutoUpdateTimer();
  if (!updateConfig?.enabled) return;

  const waitMs = delayMs ?? nextUpdateDelayMs(updateConfig);
  nextUpdateAt = new Date(Date.now() + waitMs).toISOString();
  updateTimer = setTimeout(async () => {
    try {
      await runUpdate(updateConfig.mode, "schedule");
    } catch (error) {
      console.error("Scheduled update failed:", error);
    } finally {
      scheduleAutoUpdate();
    }
  }, waitMs);
}

function nextUpdateDelayMs(config) {
  if (config.schedule_type !== "weekly") {
    return config.interval_hours * 60 * 60 * 1000;
  }

  const [hours, minutes] = config.weekly_time.split(":").map((value) => Number.parseInt(value, 10));
  const now = new Date();
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  const currentDay = now.getDay();
  let daysAhead = config.weekly_day - currentDay;
  if (daysAhead < 0 || (daysAhead === 0 && next <= now)) daysAhead += 7;
  next.setDate(next.getDate() + daysAhead);
  return Math.max(1000, next.getTime() - now.getTime());
}

function refreshAutoUpdateSchedule({ runOnStart = false } = {}) {
  if (!updateConfig?.enabled) {
    clearAutoUpdateTimer();
    return;
  }
  scheduleAutoUpdate(runOnStart ? 5000 : null);
}

updateConfig = loadUpdateConfig();

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
    running: Boolean(updateJob?.running),
    started_at: updateJob?.started_at || null,
    finished_at: updateJob?.finished_at || null,
    exit_code: updateJob?.exit_code ?? null,
    last_output: updateJob?.last_output || null,
  });
});

app.post(
  "/api/recalculate",
  asyncRoute(async (req, res) => {
    if (!requireRecalculateAccess(req, res)) return;
    const result = await runUpdate("workbook", "manual");
    res.json({ ok: true, run_id: result.run_id, output: result.job.last_output });
  }),
);

app.get("/api/update/status", (req, res) => {
  res.json(updateStatusPayload());
});

app.post(
  "/api/update/config",
  asyncRoute(async (req, res) => {
    if (!requireRecalculateAccess(req, res)) return;
    const body = req.body || {};
    const nextConfig = normalizeUpdateConfig({
      enabled: body.enabled ?? updateConfig.enabled,
      mode: body.mode ?? updateConfig.mode,
      schedule_type: body.schedule_type ?? updateConfig.schedule_type,
      interval_hours: body.interval_hours ?? updateConfig.interval_hours,
      weekly_day: body.weekly_day ?? updateConfig.weekly_day,
      weekly_time: body.weekly_time ?? updateConfig.weekly_time,
      run_on_start: body.run_on_start ?? updateConfig.run_on_start,
    });
    updateConfig = nextConfig;
    saveUpdateConfig(updateConfig);
    refreshAutoUpdateSchedule();
    res.json(updateStatusPayload());
  }),
);

app.post(
  "/api/update/run",
  asyncRoute(async (req, res) => {
    if (!requireRecalculateAccess(req, res)) return;
    const result = await runUpdate((req.body || {}).mode || updateConfig.mode, "manual");
    res.json(result);
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
  const body = {
    error: status === 500 && !error.output ? "Internal server error" : error.message,
  };
  if (error.output) body.output = error.output;
  res.status(status).json(body);
});

let server = null;

async function startServer() {
  await ensureAuthSchema();
  await ensureHardwareMarketSchema();
  server = app.listen(port, () => {
    console.log(`AI CapEx Monitor running at http://localhost:${port}`);
    refreshAutoUpdateSchedule({ runOnStart: updateConfig.run_on_start });
    scheduleHardwareMarketRefresh();
    seedHardwareMarketSnapshotIfEmpty().catch((error) => {
      console.error("Initial hardware market snapshot failed:", error);
    });
  });
}

startServer().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});

process.on("SIGTERM", async () => {
  clearHardwareMarketTimer();
  if (!server) {
    await pool.end();
    process.exit(0);
  }
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});
