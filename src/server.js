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
const authDatabase = process.env.AUTH_DATABASE || "aicapex_auth";
const tierRank = { free: 0, basic: 1, pro: 2, enterprise: 3, admin: 4 };
const validTiers = new Set(Object.keys(tierRank));
const sessionCookieName = process.env.AUTH_COOKIE_NAME || "aicapex_session";
const sessionTtlSeconds = toInt(process.env.AUTH_SESSION_TTL_SECONDS, 7 * 24 * 60 * 60, {
  min: 60 * 10,
  max: 60 * 60 * 24 * 30,
});
const authMinPasswordLength = toInt(process.env.AUTH_MIN_PASSWORD_LENGTH, 6, { min: 4, max: 128 });
const stripeWebhookToleranceSeconds = toInt(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS, 300, { min: 30, max: 3600 });
const stripeOneTimeAccessDays = toInt(process.env.STRIPE_ONE_TIME_ACCESS_DAYS, 30, { min: 1, max: 3660 });

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

function sqlIdent(name) {
  return `\`${String(name).replace(/`/g, "``")}\``;
}

function authTable(name) {
  return `${sqlIdent(authDatabase)}.${sqlIdent(name)}`;
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

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const value = String(storedHash || "");
  const [scheme, salt, expectedHash] = value.split(":");
  if (scheme === "scrypt" && salt && expectedHash) {
    const expected = Buffer.from(expectedHash, "hex");
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  const [algorithm, iterationsText, pbkdfSalt, hash] = value.split("$");
  if (algorithm !== "pbkdf2_sha256" || !iterationsText || !pbkdfSalt || !hash) return false;
  const iterations = Number.parseInt(iterationsText, 10);
  if (!Number.isFinite(iterations)) return false;
  const candidate = crypto.pbkdf2Sync(String(password), pbkdfSalt, iterations, 32, "sha256");
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function normalizeStoredTier(tier, fallback = "free") {
  const normalized = String(tier || fallback).toLowerCase();
  if (normalized === "institutional") return "enterprise";
  return ["free", "pro", "enterprise"].includes(normalized) ? normalized : fallback;
}

function appTierForUser(row) {
  if (!row) return "free";
  const role = String(row.role || "").toLowerCase();
  if (role === "admin") return "admin";
  if (subscriptionExpired(row)) return "free";
  const tier = normalizeStoredTier(row.tier, "free");
  if (tier === "enterprise") return "enterprise";
  if (tier === "pro") return "pro";
  return "free";
}

function subscriptionExpired(row) {
  const value = row?.subscription_current_period_end;
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function storedTierFromAppTier(tier) {
  const normalized = normalizeTier(tier, "free");
  if (normalized === "admin") return "enterprise";
  if (normalized === "basic") return "free";
  return ["free", "pro", "enterprise"].includes(normalized) ? normalized : "free";
}

function roleFromAppTier(tier) {
  return normalizeTier(tier, "free") === "admin" ? "admin" : "viewer";
}

function normalizeRole(role, fallback = "viewer") {
  const normalized = String(role || fallback).toLowerCase();
  return normalized === "admin" ? "admin" : "viewer";
}

function normalizeSubscriptionStatus(value, fallback = "active") {
  const normalized = String(value || fallback).trim().toLowerCase();
  return normalized || fallback;
}

function publicUser(row) {
  if (!row) return null;
  const tier = appTierForUser(row);
  const expired = tier === "free" && normalizeStoredTier(row.tier, "free") !== "free" && subscriptionExpired(row);
  return {
    user_id: row.user_id ?? row.id ?? 0,
    username: row.username || row.display_name || row.email || "guest",
    email: row.email,
    display_name: row.display_name || row.username || row.email || "Guest",
    role: normalizeRole(row.role),
    tier,
    subscription_status: expired ? "expired" : row.subscription_status || (tier === "free" ? "guest" : "active"),
    subscription_current_period_end: row.subscription_current_period_end || null,
    stripe_subscription_status: row.stripe_subscription_status || null,
    billing_portal_available: Boolean(row.stripe_customer_id),
    is_guest: Boolean(row.is_guest),
    capabilities: capabilitiesForTier(tier),
  };
}

function guestUser() {
  return {
    id: 0,
    user_id: 0,
    username: "guest",
    email: "",
    display_name: "Guest",
    role: "viewer",
    tier: "free",
    subscription_status: "guest",
    subscription_current_period_end: null,
    is_guest: true,
  };
}

function capabilitiesForTier(tier) {
  return {
    overview: hasTier(tier, "free"),
    plans: hasTier(tier, "free"),
    sources: hasTier(tier, "enterprise"),
    breakdowns: hasTier(tier, "pro"),
    bridge: hasTier(tier, "pro"),
    finance: hasTier(tier, "pro"),
    hardware: hasTier(tier, "pro"),
    artifacts: hasTier(tier, "enterprise"),
    automation: hasTier(tier, "admin"),
    admin: hasTier(tier, "admin"),
  };
}

function normalizeTier(tier, fallback = "free") {
  const normalized = String(tier || fallback).toLowerCase();
  if (normalized === "institutional") return "enterprise";
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
  const sessionToken = parseCookies(req.headers.cookie)[sessionCookieName];
  if (!sessionToken) return null;
  const rows = await query(
	    `SELECT u.id, u.id AS user_id, u.username, u.email, u.username AS display_name,
	            u.role, u.tier, u.subscription_status, u.subscription_current_period_end,
	            u.stripe_customer_id, u.stripe_subscription_status
	     FROM ${authTable("usersessions")} s
	     JOIN ${authTable("siteusers")} u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP
       AND COALESCE(u.subscription_status, 'active') <> 'disabled'
     LIMIT 1`,
    [hashToken(sessionToken)],
  );
  if (!rows.length) return null;
  req.session_token = sessionToken;
  return publicUser(rows[0]);
}

async function authenticateRequest(req, res, next) {
  req.user = (await authUserFromRequest(req)) || guestUser();
  next();
}

function minimumTierForPath(pathname, method) {
  if (pathname === "/health") return null;
  if (pathname.startsWith("/auth/")) return null;
  if (pathname.startsWith("/plans")) return null;
  if (pathname.startsWith("/subscriptions/")) return null;
  if (pathname.startsWith("/users")) return "admin";
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
  if (pathname.startsWith("/sources")) return "enterprise";
  return "free";
}

function enforceApiTier(req, res, next) {
  const required = minimumTierForPath(req.path, req.method);
  if (!required) return next();
  if (!req.user) req.user = guestUser();
  if (req.user.is_guest && required !== "free") return res.status(401).json({ error: "Authentication required" });
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
  await query(`CREATE DATABASE IF NOT EXISTS ${sqlIdent(authDatabase)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await query(
    `CREATE TABLE IF NOT EXISTS ${authTable("siteusers")} (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       username VARCHAR(128) NOT NULL,
       email VARCHAR(255) NULL,
       password_hash VARCHAR(255) NULL,
       role VARCHAR(64) NOT NULL DEFAULT 'viewer',
	       tier VARCHAR(64) NOT NULL DEFAULT 'free',
	       subscription_status VARCHAR(64) NOT NULL DEFAULT 'active',
	       stripe_customer_id VARCHAR(255) NULL,
	       stripe_subscription_id VARCHAR(255) NULL,
	       stripe_checkout_session_id VARCHAR(255) NULL,
	       stripe_subscription_status VARCHAR(64) NULL,
	       subscription_current_period_end TIMESTAMP NULL,
	       metadata JSON NULL,
	       last_login_at TIMESTAMP NULL,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uniq_siteusers_username (username),
       UNIQUE KEY uniq_siteusers_email (email)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS ${authTable("usersessions")} (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       user_id BIGINT UNSIGNED NOT NULL,
       token_hash CHAR(64) NOT NULL,
       expires_at TIMESTAMP NOT NULL,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uniq_usersessions_token_hash (token_hash),
       KEY idx_usersessions_user_id (user_id),
       KEY idx_usersessions_expires_at (expires_at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
  await ensureAuthColumn("siteusers", "tier", "tier VARCHAR(64) NOT NULL DEFAULT 'free'");
  await ensureAuthColumn("siteusers", "subscription_status", "subscription_status VARCHAR(64) NOT NULL DEFAULT 'active'");
  await ensureAuthColumn("siteusers", "stripe_customer_id", "stripe_customer_id VARCHAR(255) NULL");
  await ensureAuthColumn("siteusers", "stripe_subscription_id", "stripe_subscription_id VARCHAR(255) NULL");
  await ensureAuthColumn("siteusers", "stripe_checkout_session_id", "stripe_checkout_session_id VARCHAR(255) NULL");
  await ensureAuthColumn("siteusers", "stripe_subscription_status", "stripe_subscription_status VARCHAR(64) NULL");
  await ensureAuthColumn("siteusers", "subscription_current_period_end", "subscription_current_period_end TIMESTAMP NULL");
  await ensureAuthColumn("siteusers", "last_login_at", "last_login_at TIMESTAMP NULL");
  await query(`DELETE FROM ${authTable("usersessions")} WHERE expires_at <= CURRENT_TIMESTAMP`);
  await bootstrapAuthUser();
}

async function ensureAuthColumn(table, column, definition) {
  const rows = await query(
    `SELECT COUNT(*) AS column_count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [authDatabase, table, column],
  );
  if (Number(rows[0]?.column_count || 0) === 0) {
    await query(`ALTER TABLE ${authTable(table)} ADD COLUMN ${definition}`);
  }
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
    const countRows = await query(`SELECT COUNT(*) AS user_count FROM ${authTable("siteusers")}`);
    if (!countRows[0]?.user_count) {
      console.warn("No auth users exist. Set AUTH_BOOTSTRAP_EMAIL and AUTH_BOOTSTRAP_PASSWORD or run npm run user:create.");
    }
    return;
  }
  const normalizedEmail = normalizeEmail(email);
  const existing = await query(`SELECT id FROM ${authTable("siteusers")} WHERE email = ? LIMIT 1`, [normalizedEmail]);
  if (existing.length) return;
  const username = normalizeUsername(
    process.env.AUTH_BOOTSTRAP_USERNAME || process.env.AUTH_BOOTSTRAP_NAME || normalizedEmail.split("@")[0] || "admin",
  );
  const bootstrapTier = normalizeTier(process.env.AUTH_BOOTSTRAP_TIER || "admin", "admin");
  await query(
    `INSERT INTO ${authTable("siteusers")}
       (username, email, password_hash, role, tier, subscription_status, metadata)
     VALUES (?, ?, ?, ?, ?, 'active', JSON_OBJECT())`,
    [
      username,
      normalizedEmail,
      hashPassword(password),
      roleFromAppTier(bootstrapTier),
      storedTierFromAppTier(bootstrapTier),
    ],
  );
}

function stripeSecretConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function stripeWebhookConfigured() {
  return Boolean(process.env.STRIPE_WEBHOOK_SECRET);
}

function stripeCheckoutConfiguredForPlan(planId) {
  return Boolean(stripeSecretConfigured() && stripeWebhookConfigured() && stripePriceForPlan(planId));
}

function stripeOneTimeCheckoutConfiguredForPlan(planId) {
  return Boolean(stripeSecretConfigured() && stripeWebhookConfigured() && stripeOneTimePriceForPlan(planId));
}

function stripeConfigStatus() {
  return {
    publishable_key_configured: Boolean(process.env.STRIPE_PUBLISHABLE_KEY),
    secret_key_configured: stripeSecretConfigured(),
    webhook_secret_configured: stripeWebhookConfigured(),
    checkout_configured: Boolean(stripeSecretConfigured() && stripeWebhookConfigured()),
    prices: {
      pro: Boolean(stripePriceForPlan("pro")),
      enterprise: Boolean(stripePriceForPlan("enterprise")),
    },
    one_time_prices: {
      pro: Boolean(stripeOneTimePriceForPlan("pro")),
      enterprise: Boolean(stripeOneTimePriceForPlan("enterprise")),
    },
    promotion_codes_enabled: process.env.STRIPE_ALLOW_PROMOTION_CODES === "true",
  };
}

function stripeId(value) {
  return value ? String(value) : null;
}

function stripeTimestampToMysql(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function mysqlDateAfterDays(days) {
  const timestamp = Date.now() + Number(days || 0) * 24 * 60 * 60 * 1000;
  return new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
}

function checkoutMode(value) {
  return ["one_time", "payment"].includes(String(value || "").toLowerCase()) ? "one_time" : "subscription";
}

function normalizeStripeLocale(value) {
  const normalized = String(value || "auto").toLowerCase();
  if (["auto", "en", "es", "zh"].includes(normalized)) return normalized;
  if (normalized.startsWith("zh")) return "zh";
  if (normalized.startsWith("es")) return "es";
  if (normalized.startsWith("en")) return "en";
  return "auto";
}

async function stripeRequest(pathname, params) {
  if (!stripeSecretConfigured()) {
    const error = new Error("Payment is not configured. Please contact the administrator.");
    error.status = 503;
    error.error_code = "payment_not_configured";
    throw error;
  }
  const response = await fetch(`https://api.stripe.com/v1/${pathname.replace(/^\/+/, "")}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || "Stripe request failed");
    error.status = 502;
    error.stripe_error = body.error || body;
    throw error;
  }
  return body;
}

function stripeWebhookError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function verifyStripeWebhookSignature(payload, signatureHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw stripeWebhookError("Stripe webhook secret is not configured", 503);
  if (!signatureHeader) throw stripeWebhookError("Missing Stripe signature header");

  const parts = String(signatureHeader).split(",");
  const values = new Map();
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(value);
  }

  const timestamp = Number(values.get("t")?.[0]);
  const signatures = values.get("v1") || [];
  if (!Number.isFinite(timestamp) || !signatures.length) throw stripeWebhookError("Invalid Stripe signature header");
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > stripeWebhookToleranceSeconds) throw stripeWebhookError("Stripe webhook timestamp is outside tolerance");

  const signedPayload = `${timestamp}.${payload.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const matched = signatures.some((signature) => {
    const actualBuffer = Buffer.from(signature, "hex");
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  });
  if (!matched) throw stripeWebhookError("Invalid Stripe webhook signature");
}

function paidTierFromStripeMetadata(metadata = {}) {
  const planId = normalizeTier(metadata.plan_id, "free");
  return ["pro", "enterprise"].includes(planId) ? planId : null;
}

async function userIdForStripeSubscription(subscription) {
  const metadataUserId = Number.parseInt(subscription.metadata?.user_id, 10);
  if (Number.isFinite(metadataUserId) && metadataUserId > 0) return metadataUserId;
  const rows = await query(
    `SELECT id
     FROM ${authTable("siteusers")}
     WHERE stripe_subscription_id = ? OR stripe_customer_id = ?
     LIMIT 1`,
    [stripeId(subscription.id), stripeId(subscription.customer)],
  );
  return rows[0]?.id || null;
}

async function handleStripeCheckoutCompleted(session) {
  const planId = paidTierFromStripeMetadata(session.metadata);
  const userId = Number.parseInt(session.metadata?.user_id || session.client_reference_id, 10);
  if (!planId || !Number.isFinite(userId) || userId <= 0) return;
  if (session.payment_status && !["paid", "no_payment_required"].includes(session.payment_status)) return;
  if (session.mode === "subscription") {
    await setUserSubscription(userId, planId, "active", {
      customerId: stripeId(session.customer),
      subscriptionId: stripeId(session.subscription),
      checkoutSessionId: stripeId(session.id),
      stripeSubscriptionStatus: session.status || "complete",
    });
  } else if (session.mode === "payment") {
    const accessDays = toInt(session.metadata?.access_days, stripeOneTimeAccessDays, { min: 1, max: 3660 });
    await setUserSubscription(userId, planId, "active", {
      customerId: stripeId(session.customer),
      subscriptionId: null,
      checkoutSessionId: stripeId(session.id),
      stripeSubscriptionStatus: session.payment_status || session.status || "complete",
      currentPeriodEnd: mysqlDateAfterDays(accessDays),
    });
  }
}

async function handleStripeSubscriptionChanged(subscription) {
  const userId = await userIdForStripeSubscription(subscription);
  const planId = paidTierFromStripeMetadata(subscription.metadata);
  if (!userId) return;

  const status = String(subscription.status || "unknown");
  const active = ["active", "trialing"].includes(status);
  await setUserSubscription(userId, active && planId ? planId : "free", status, {
    customerId: stripeId(subscription.customer),
    subscriptionId: stripeId(subscription.id),
    stripeSubscriptionStatus: status,
    currentPeriodEnd: stripeTimestampToMysql(subscription.current_period_end),
  });
}

async function handleStripeWebhookEvent(event) {
  const object = event?.data?.object;
  if (!object) return;
  if (event.type === "checkout.session.completed") {
    await handleStripeCheckoutCompleted(object);
  } else if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    await handleStripeSubscriptionChanged(object);
  }
}

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  asyncRoute(async (req, res) => {
    verifyStripeWebhookSignature(req.body, req.headers["stripe-signature"]);
    const event = JSON.parse(req.body.toString("utf8"));
    await handleStripeWebhookEvent(event);
    res.json({ received: true });
  }),
);

app.use(express.json());

app.post(
  "/api/auth/login",
  asyncRoute(async (req, res) => {
    const identifier = normalizeIdentifier(req.body?.identifier || req.body?.email || req.body?.username);
    const password = String(req.body?.password || "");
    if (!identifier || !password) return res.status(400).json({ error: "Email/username and password are required" });

    const rows = await query(
      `SELECT id, id AS user_id, username, email, username AS display_name,
              password_hash, role, tier, subscription_status, subscription_current_period_end,
              stripe_customer_id, stripe_subscription_status
       FROM ${authTable("siteusers")}
       WHERE username = ? OR email = ?
       LIMIT 1`,
      [identifier, identifier],
    );
    const user = rows[0];
    if (!user || user.subscription_status === "disabled" || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const sessionToken = crypto.randomBytes(32).toString("base64url");
    await query(
      `INSERT INTO ${authTable("usersessions")} (user_id, token_hash, expires_at)
       VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND))`,
      [user.user_id, hashToken(sessionToken), sessionTtlSeconds],
    );
    await query(`UPDATE ${authTable("siteusers")} SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`, [user.user_id]);
    setSessionCookie(res, sessionToken);
    res.json({ user: publicUser(user) });
  }),
);

app.post(
  "/api/auth/register",
  asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const username = normalizeUsername(req.body?.username || req.body?.name || email.split("@")[0]);
    const password = String(req.body?.password || "");
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (password.length < authMinPasswordLength) {
      return res.status(400).json({ error: `Password must be at least ${authMinPasswordLength} characters` });
    }

    try {
      await query(
        `INSERT INTO ${authTable("siteusers")}
           (username, email, password_hash, role, tier, subscription_status, metadata)
         VALUES (?, ?, ?, ?, ?, 'active', JSON_OBJECT())`,
        [username, email, hashPassword(password), "viewer", "free"],
      );
    } catch (error) {
      if (String(error.code || "") === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "Username or email already exists" });
      }
      throw error;
    }

    const rows = await query(
      `SELECT id, id AS user_id, username, email, username AS display_name,
              role, tier, subscription_status, subscription_current_period_end,
              stripe_customer_id, stripe_subscription_status
       FROM ${authTable("siteusers")}
       WHERE username = ?
       LIMIT 1`,
      [username],
    );
    const user = rows[0];
    const sessionToken = crypto.randomBytes(32).toString("base64url");
    await query(
      `INSERT INTO ${authTable("usersessions")} (user_id, token_hash, expires_at)
       VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND))`,
      [user.user_id, hashToken(sessionToken), sessionTtlSeconds],
    );
    setSessionCookie(res, sessionToken);
    res.status(201).json({ user: publicUser(user) });
  }),
);

app.post(
  "/api/auth/logout",
  asyncRoute(async (req, res) => {
    const sessionToken = parseCookies(req.headers.cookie)[sessionCookieName];
    if (sessionToken) await query(`DELETE FROM ${authTable("usersessions")} WHERE token_hash = ?`, [hashToken(sessionToken)]);
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

app.get(
  "/api/auth/me",
  asyncRoute(async (req, res) => {
    const user = (await authUserFromRequest(req)) || guestUser();
    res.json({ user: publicUser(user), tiers: Object.keys(tierRank) });
  }),
);

app.use("/api", asyncRoute(authenticateRequest), enforceApiTier);

const planDefinitions = [
  {
    id: "free",
    name: "Free",
    currency: "cny",
    price_monthly_cny: 0,
    price_one_time_cny: 0,
    one_time_access_days: stripeOneTimeAccessDays,
    audience: "Public preview and product trial.",
    features: ["Global overview", "2030 mix snapshot", "Limited dashboard access"],
  },
  {
    id: "pro",
    name: "Pro",
    currency: "cny",
    price_monthly_cny: 49,
    price_one_time_cny: 49,
    one_time_access_days: stripeOneTimeAccessDays,
    audience: "Individual investors and analysts.",
    features: ["Entity drilldowns", "Country-company bridge", "Funding and ROIC", "AI hardware breadth"],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    currency: "cny",
    price_monthly_cny: 499,
    price_one_time_cny: 499,
    one_time_access_days: stripeOneTimeAccessDays,
    audience: "Teams that need full model output and audit trails.",
    features: ["All Pro features", "Source register", "Model audit", "External data and update controls by admin"],
  },
];

function stripePriceForPlan(planId) {
  const key = `STRIPE_PRICE_${String(planId || "").toUpperCase()}`;
  return process.env[key] || "";
}

function stripeOneTimePriceForPlan(planId) {
  const key = `STRIPE_PRICE_${String(planId || "").toUpperCase()}_ONE_TIME`;
  return process.env[key] || "";
}

function publicPlan(plan) {
  return {
    ...plan,
    stripe_price_configured: Boolean(stripePriceForPlan(plan.id)),
    stripe_one_time_price_configured: Boolean(stripeOneTimePriceForPlan(plan.id)),
  };
}

async function setUserSubscription(userId, tier, subscriptionStatus = "active", stripe = {}) {
  const appTier = normalizeTier(tier, "free");
  const updates = ["role = ?", "tier = ?", "subscription_status = ?"];
  const params = [roleFromAppTier(appTier), storedTierFromAppTier(appTier), subscriptionStatus];
  const optionalColumns = [
    ["customerId", "stripe_customer_id"],
    ["subscriptionId", "stripe_subscription_id"],
    ["checkoutSessionId", "stripe_checkout_session_id"],
    ["stripeSubscriptionStatus", "stripe_subscription_status"],
    ["currentPeriodEnd", "subscription_current_period_end"],
  ];
  for (const [key, column] of optionalColumns) {
    if (Object.prototype.hasOwnProperty.call(stripe, key)) {
      updates.push(`${column} = ?`);
      params.push(stripe[key] || null);
    }
  }
  params.push(userId);
  await query(
    `UPDATE ${authTable("siteusers")}
     SET ${updates.join(", ")}
     WHERE id = ?`,
    params,
  );
  const rows = await query(
        `SELECT id, id AS user_id, username, email, username AS display_name,
            role, tier, subscription_status, subscription_current_period_end,
            stripe_customer_id, stripe_subscription_status
     FROM ${authTable("siteusers")}
     WHERE id = ?
     LIMIT 1`,
    [userId],
  );
  return publicUser(rows[0]);
}

app.get(
  "/api/plans",
  asyncRoute(async (req, res) => {
    const stripeStatus = stripeConfigStatus();
    res.json({
      plans: planDefinitions.map(publicPlan),
      stripe_configured: Boolean(
        stripeStatus.checkout_configured &&
          stripeStatus.prices.pro &&
          stripeStatus.prices.enterprise &&
          stripeStatus.one_time_prices.pro &&
          stripeStatus.one_time_prices.enterprise,
      ),
      stripe: stripeStatus,
    });
  }),
);

app.post(
  "/api/subscriptions/checkout",
  asyncRoute(async (req, res) => {
    const planId = normalizeTier(req.body?.plan_id || "free", "free");
    const mode = checkoutMode(req.body?.checkout_mode || req.body?.mode);
    if (!["free", "pro", "enterprise"].includes(planId)) {
      return res.status(400).json({ error: "Invalid plan" });
    }
    if (!req.user || req.user.is_guest) {
      return res.status(401).json({ error: "Please register or sign in before subscribing" });
    }
    if (planId === "free") {
      const user = await setUserSubscription(req.user.user_id, "free", "active");
      return res.json({ mode: "local", plan_id: "free", user, checkout_url: req.body?.success_url || "/" });
    }

    const priceId = mode === "one_time" ? stripeOneTimePriceForPlan(planId) : stripePriceForPlan(planId);
    const successUrl = String(req.body?.success_url || `${req.protocol}://${req.get("host")}/?checkout=success`);
    const cancelUrl = String(req.body?.cancel_url || `${req.protocol}://${req.get("host")}/?checkout=cancel`);
    if (mode === "one_time" ? !stripeOneTimeCheckoutConfiguredForPlan(planId) : !stripeCheckoutConfiguredForPlan(planId)) {
      return res.status(503).json({
        error: "Payment is not fully configured. Please contact the administrator.",
        error_code: "payment_not_configured",
      });
    }

    const userRows = await query(
      `SELECT stripe_customer_id FROM ${authTable("siteusers")} WHERE id = ? LIMIT 1`,
      [req.user.user_id],
    );
    const customerId = stripeId(userRows[0]?.stripe_customer_id);
    const params = new URLSearchParams();
    params.set("mode", mode === "one_time" ? "payment" : "subscription");
    params.set("success_url", successUrl);
    params.set("cancel_url", cancelUrl);
    if (customerId) {
      params.set("customer", customerId);
    } else {
      params.set("customer_email", req.user.email || "");
      if (mode === "one_time") params.set("customer_creation", "always");
    }
    params.set("client_reference_id", String(req.user.user_id));
    params.set("metadata[user_id]", String(req.user.user_id));
    params.set("metadata[plan_id]", planId);
    params.set("metadata[checkout_mode]", mode);
    if (mode === "one_time") {
      params.set("metadata[access_days]", String(stripeOneTimeAccessDays));
      params.set("payment_intent_data[metadata][user_id]", String(req.user.user_id));
      params.set("payment_intent_data[metadata][plan_id]", planId);
      params.set("payment_intent_data[metadata][checkout_mode]", mode);
    } else {
      params.set("subscription_data[metadata][user_id]", String(req.user.user_id));
      params.set("subscription_data[metadata][plan_id]", planId);
    }
    params.set("line_items[0][price]", priceId);
    params.set("line_items[0][quantity]", "1");
    params.set("locale", normalizeStripeLocale(req.body?.locale || process.env.STRIPE_CHECKOUT_LOCALE));
    if (process.env.STRIPE_ALLOW_PROMOTION_CODES === "true") params.set("allow_promotion_codes", "true");

    const body = await stripeRequest("checkout/sessions", params);
    res.json({ mode: "stripe", checkout_mode: mode, plan_id: planId, checkout_url: body.url, session_id: body.id });
  }),
);

app.post(
  "/api/subscriptions/portal",
  asyncRoute(async (req, res) => {
    if (!req.user || req.user.is_guest) {
      return res.status(401).json({ error: "Please register or sign in before managing billing" });
    }
    const rows = await query(
      `SELECT stripe_customer_id
       FROM ${authTable("siteusers")}
       WHERE id = ?
       LIMIT 1`,
      [req.user.user_id],
    );
    const customerId = stripeId(rows[0]?.stripe_customer_id);
    if (!customerId) {
      return res.status(404).json({
        error: "No Stripe billing profile is linked to this account.",
        error_code: "billing_profile_missing",
      });
    }
    const returnUrl = String(req.body?.return_url || `${req.protocol}://${req.get("host")}/#plans`);
    const params = new URLSearchParams();
    params.set("customer", customerId);
    params.set("return_url", returnUrl);
    const session = await stripeRequest("billing_portal/sessions", params);
    res.json({ mode: "stripe_portal", portal_url: session.url });
  }),
);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeUsername(value) {
  const base = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 40);
  const username = base || `user${crypto.randomBytes(3).toString("hex")}`;
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) {
    const error = new Error("Username must be 3-40 letters, numbers, dots, underscores, or dashes");
    error.status = 400;
    throw error;
  }
  return username;
}

function normalizeIdentifier(value) {
  return String(value || "").trim().toLowerCase();
}

function publicManagedUser(row) {
  const tier = appTierForUser(row);
  return {
    user_id: row.id ?? row.user_id,
    username: row.username,
    email: row.email,
    display_name: row.display_name || row.username || row.email,
    role: normalizeRole(row.role),
    tier,
    subscription_status: row.subscription_status || "active",
    subscription_current_period_end: row.subscription_current_period_end || null,
    active: row.subscription_status !== "disabled",
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
  };
}

function validateManagedUserInput(input, { creating = false, fallbackTier = "free" } = {}) {
  const email = normalizeEmail(input.email);
  const displayName = String(input.display_name || input.name || "").trim();
  const username = input.username === undefined ? "" : normalizeUsername(input.username);
  const tierText = String(input.tier || fallbackTier).toLowerCase();
  if (!validTiers.has(tierText)) {
    const error = new Error("Tier must be free, basic, pro, enterprise, or admin");
    error.status = 400;
    throw error;
  }
  const tier = tierText;
  const active = input.active === undefined ? true : Boolean(input.active);
  const password = input.password === undefined ? "" : String(input.password);
  if (creating && !email) {
    const error = new Error("Email is required");
    error.status = 400;
    throw error;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error("Email is invalid");
    error.status = 400;
    throw error;
  }
  if (creating && !password) {
    const error = new Error("Password is required");
    error.status = 400;
    throw error;
  }
  if (password && password.length < authMinPasswordLength) {
    const error = new Error(`Password must be at least ${authMinPasswordLength} characters`);
    error.status = 400;
    throw error;
  }
  return { email, username, displayName, tier, active, password };
}

app.get(
  "/api/users",
  asyncRoute(async (req, res) => {
    const rows = await query(
    `SELECT id, username, email, username AS display_name, role, tier, subscription_status,
              subscription_current_period_end, created_at, updated_at, last_login_at
       FROM ${authTable("siteusers")}
       ORDER BY created_at DESC`,
    );
    res.json({ rows: rows.map(publicManagedUser), tiers: Object.keys(tierRank) });
  }),
);

app.post(
  "/api/users",
  asyncRoute(async (req, res) => {
    const input = validateManagedUserInput(req.body || {}, { creating: true });
    const username = input.username || normalizeUsername(input.displayName || input.email.split("@")[0]);
    const existing = await query(
      `SELECT id FROM ${authTable("siteusers")} WHERE email = ? OR username = ? LIMIT 1`,
      [input.email, username],
    );
    if (existing.length) {
      const error = new Error("User already exists");
      error.status = 409;
      throw error;
    }
    await query(
      `INSERT INTO ${authTable("siteusers")}
         (username, email, password_hash, role, tier, subscription_status, metadata)
       VALUES (?, ?, ?, ?, ?, ?, JSON_OBJECT())`,
      [
        username,
        input.email,
        hashPassword(input.password),
        roleFromAppTier(input.tier),
        storedTierFromAppTier(input.tier),
        input.active ? "active" : "disabled",
      ],
    );
    const rows = await query(
      `SELECT id, username, email, username AS display_name, role, tier, subscription_status,
              subscription_current_period_end, created_at, updated_at, last_login_at
       FROM ${authTable("siteusers")}
       WHERE email = ?
       LIMIT 1`,
      [input.email],
    );
    res.status(201).json({ user: publicManagedUser(rows[0]) });
  }),
);

app.patch(
  "/api/users/:userId",
  asyncRoute(async (req, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) {
      const error = new Error("Invalid user id");
      error.status = 400;
      throw error;
    }
    const currentRows = await query(
      `SELECT id, username, email, role, tier, subscription_status, subscription_current_period_end FROM ${authTable("siteusers")} WHERE id = ? LIMIT 1`,
      [userId],
    );
    if (!currentRows.length) {
      const error = new Error("User not found");
      error.status = 404;
      throw error;
    }
    const currentTier = appTierForUser(currentRows[0]);
    const input = validateManagedUserInput(req.body || {}, { fallbackTier: currentTier });
    if (userId === req.user.user_id && (!input.active || input.tier !== "admin")) {
      const error = new Error("You cannot deactivate or downgrade your own admin account");
      error.status = 400;
      throw error;
    }
    const updates = ["role = ?", "tier = ?", "subscription_status = ?"];
    const params = [
      roleFromAppTier(input.tier),
      storedTierFromAppTier(input.tier),
      input.active ? normalizeSubscriptionStatus(req.body?.subscription_status, "active") : "disabled",
    ];
    if (input.displayName || input.username) {
      updates.push("username = ?");
      params.push(input.username || normalizeUsername(input.displayName));
    }
    if (input.password) {
      updates.push("password_hash = ?");
      params.push(hashPassword(input.password));
    }
    params.push(userId);
    await query(`UPDATE ${authTable("siteusers")} SET ${updates.join(", ")} WHERE id = ?`, params);
    const rows = await query(
      `SELECT id, username, email, username AS display_name, role, tier, subscription_status,
              subscription_current_period_end, created_at, updated_at, last_login_at
       FROM ${authTable("siteusers")}
       WHERE id = ?
       LIMIT 1`,
      [userId],
    );
    res.json({ user: publicManagedUser(rows[0]) });
  }),
);

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

function nasdaqDateRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 210 * 24 * 60 * 60 * 1000);
  return {
    fromDate: from.toISOString().slice(0, 10),
    toDate: to.toISOString().slice(0, 10),
  };
}

function parseNasdaqDate(value) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, month, day, year] = match;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseNasdaqPrice(value) {
  const parsed = Number(String(value || "").replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchNasdaqHistory(symbol) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const { fromDate, toDate } = nasdaqDateRange();
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(
      symbol,
    )}/historical?assetclass=stocks&fromdate=${fromDate}&todate=${toDate}&limit=9999`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
        Origin: "https://www.nasdaq.com",
        Referer: "https://www.nasdaq.com/",
        "User-Agent": "Mozilla/5.0 aicapex-monitor/0.1",
      },
    });
    if (!response.ok) throw new Error(`Nasdaq historical ${response.status}`);
    const body = await response.json();
    const rows = (body?.data?.tradesTable?.rows || [])
      .map((row) => ({
        date: parseNasdaqDate(row.date),
        close: parseNasdaqPrice(row.close),
      }))
      .filter((row) => row.date && Number.isFinite(row.close) && row.close > 0)
      .sort((left, right) => left.date.localeCompare(right.date));
    if (rows.length < 20) throw new Error("Nasdaq historical unavailable");
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPriceHistory(symbol) {
  try {
    return { history: await fetchYahooHistory(symbol), source: "Yahoo Finance chart endpoint" };
  } catch (yahooError) {
    try {
      return { history: await fetchNasdaqHistory(symbol), source: "Nasdaq historical endpoint" };
    } catch (nasdaqError) {
      throw new Error(`${yahooError.message}; ${nasdaqError.message}`);
    }
  }
}

function summarizeHistory(constituent, history, priceSource) {
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
    price_source: priceSource,
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

function mergeTrackConstituentWithMarketData(trackConstituent, fetchedBySymbol) {
  const fetched = fetchedBySymbol.get(trackConstituent.symbol);
  if (!fetched) return trackConstituent;
  const { symbol, company_name, role, weight, ...marketData } = fetched;
  return {
    ...marketData,
    ...trackConstituent,
  };
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
      const { history, source } = await fetchPriceHistory(constituent.symbol);
      return summarizeHistory(constituent, history, source);
    } catch (error) {
      return { ...constituent, error: error.message };
    }
  });
  const fetchedBySymbol = new Map(fetched.map((item) => [item.symbol, item]));

  const tracks = (hardwareConfig.tracks || []).map((track) => {
    const constituents = (track.constituents || []).map((item) =>
      mergeTrackConstituentWithMarketData(item, fetchedBySymbol),
    );
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
    source: "Yahoo Finance chart endpoint with Nasdaq historical fallback",
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

  await query("DELETE FROM hardware_market_track_snapshots WHERE snapshot_date = ?", [snapshotDate]);
  await query("DELETE FROM hardware_market_constituent_snapshots WHERE snapshot_date = ?", [snapshotDate]);

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
  if (error.error_code) body.error_code = error.error_code;
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
