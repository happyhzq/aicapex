#!/usr/bin/env node
"use strict";

const path = require("node:path");
const crypto = require("node:crypto");

const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const authDatabase = process.env.AUTH_DATABASE || "aicapex_auth";
const validTiers = new Set(["free", "pro", "enterprise", "admin"]);
const authMinPasswordLength = toInt(process.env.AUTH_MIN_PASSWORD_LENGTH, 6, { min: 4, max: 128 });

function usage() {
  return `
Usage:
  npm run user:create -- --email user@example.com --password 'secret123' --tier pro [--username user] [--name user]
  npm run user:create -- --email user@example.com --tier enterprise --no-password-change

Tiers:
  free        Public preview
  pro         Drilldowns, bridge, funding, ROIC, and hardware breadth
  enterprise Full model output and audit APIs
  admin       Enterprise plus user/update/recalculation controls
`.trim();
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "help") flags.help = true;
    else if (key === "active") flags.active = true;
    else if (key === "inactive") flags.inactive = true;
    else if (key === "no-password-change") flags.noPasswordChange = true;
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
      flags[key] = value;
      index += 1;
    }
  }
  return flags;
}

function toInt(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sqlIdent(name) {
  return `\`${String(name).replace(/`/g, "``")}\``;
}

function authTable(name) {
  return `${sqlIdent(authDatabase)}.${sqlIdent(name)}`;
}

function normalizeUsername(value) {
  const username = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 40);
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) {
    throw new Error("--username must be 3-40 letters, numbers, dots, underscores, or dashes");
  }
  return username;
}

function normalizeTier(tier) {
  const value = String(tier || "free").toLowerCase();
  if (!validTiers.has(value)) throw new Error("--tier must be free, pro, enterprise, or admin");
  return value;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function roleFromTier(tier) {
  return tier === "admin" ? "admin" : "viewer";
}

function storageTier(tier) {
  return tier === "admin" ? "enterprise" : tier;
}

async function ensureAuthSchema(connection) {
  await connection.query(
    `CREATE DATABASE IF NOT EXISTS ${sqlIdent(authDatabase)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await connection.query(
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
  await connection.query(
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
  await ensureAuthColumn(connection, "siteusers", "tier", "tier VARCHAR(64) NOT NULL DEFAULT 'free'");
  await ensureAuthColumn(connection, "siteusers", "subscription_status", "subscription_status VARCHAR(64) NOT NULL DEFAULT 'active'");
  await ensureAuthColumn(connection, "siteusers", "stripe_customer_id", "stripe_customer_id VARCHAR(255) NULL");
  await ensureAuthColumn(connection, "siteusers", "stripe_subscription_id", "stripe_subscription_id VARCHAR(255) NULL");
  await ensureAuthColumn(connection, "siteusers", "stripe_checkout_session_id", "stripe_checkout_session_id VARCHAR(255) NULL");
  await ensureAuthColumn(connection, "siteusers", "stripe_subscription_status", "stripe_subscription_status VARCHAR(64) NULL");
  await ensureAuthColumn(connection, "siteusers", "subscription_current_period_end", "subscription_current_period_end TIMESTAMP NULL");
  await ensureAuthColumn(connection, "siteusers", "last_login_at", "last_login_at TIMESTAMP NULL");
}

async function ensureAuthColumn(connection, table, column, definition) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS column_count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [authDatabase, table, column],
  );
  if (Number(rows[0]?.column_count || 0) === 0) {
    await connection.query(`ALTER TABLE ${authTable(table)} ADD COLUMN ${definition}`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const email = String(flags.email || "").trim().toLowerCase();
  const tier = normalizeTier(flags.tier || "free");
  const username = normalizeUsername(flags.username || flags.name || email.split("@")[0]);
  if (!email) throw new Error("--email is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("--email is invalid");
  if (!flags.password && !flags.noPasswordChange) throw new Error("--password is required unless --no-password-change is set");
  if (flags.password && String(flags.password).length < authMinPasswordLength) {
    throw new Error(`--password must be at least ${authMinPasswordLength} characters`);
  }

  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    charset: "utf8mb4",
  });

  try {
    await ensureAuthSchema(connection);
    const subscriptionStatus = flags.inactive ? "disabled" : "active";
    const [rows] = await connection.query(`SELECT id FROM ${authTable("siteusers")} WHERE email = ? LIMIT 1`, [email]);
    if (rows.length) {
      const updates = ["username = ?", "role = ?", "tier = ?", "subscription_status = ?"];
      const params = [username, roleFromTier(tier), storageTier(tier), subscriptionStatus];
      if (!flags.noPasswordChange) {
        updates.push("password_hash = ?");
        params.push(hashPassword(flags.password));
      }
      params.push(email);
      await connection.query(`UPDATE ${authTable("siteusers")} SET ${updates.join(", ")} WHERE email = ?`, params);
      console.log(`Updated user ${email} (${tier}) in ${authDatabase}.siteusers`);
    } else {
      await connection.query(
        `INSERT INTO ${authTable("siteusers")}
           (username, email, password_hash, role, tier, subscription_status, metadata)
         VALUES (?, ?, ?, ?, ?, ?, JSON_OBJECT())`,
        [username, email, hashPassword(flags.password), roleFromTier(tier), storageTier(tier), subscriptionStatus],
      );
      console.log(`Created user ${email} (${tier}) in ${authDatabase}.siteusers`);
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  const message = String(error.stack || error.message || error).replace(process.env.MYSQL_PASSWORD || "", "***");
  console.error(message);
  console.error("");
  console.error(usage());
  process.exit(1);
});
