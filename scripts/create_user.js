#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const validTiers = new Set(["basic", "pro", "enterprise", "admin"]);

function usage() {
  return `
Usage:
  npm run user:create -- --email user@example.com --password 'secret' --tier pro [--name 'User Name']
  npm run user:create -- --email user@example.com --tier enterprise --no-password-change

Tiers:
  basic       Overview and source register
  pro         Basic plus drilldowns, bridge, funding, and ROIC
  enterprise  Pro plus model artifacts, external data, and adjustment audit
  admin       Enterprise plus update/recalculation controls
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

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex"), iterations = 310000) {
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

async function ensureAuthSchema(connection) {
  await connection.query(
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
  await connection.query(
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
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const email = String(flags.email || "").trim().toLowerCase();
  const tier = String(flags.tier || "basic").toLowerCase();
  if (!email) throw new Error("--email is required");
  if (!validTiers.has(tier)) throw new Error("--tier must be basic, pro, enterprise, or admin");
  if (!flags.password && !flags.noPasswordChange) throw new Error("--password is required unless --no-password-change is set");

  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    charset: "utf8mb4",
  });

  try {
    await ensureAuthSchema(connection);
    const active = flags.inactive ? 0 : 1;
    const [rows] = await connection.query("SELECT user_id FROM app_users WHERE email = ? LIMIT 1", [email]);
    if (rows.length) {
      const updates = ["display_name = COALESCE(?, display_name)", "tier = ?", "active = ?"];
      const params = [flags.name || null, tier, active];
      if (!flags.noPasswordChange) {
        updates.push("password_hash = ?");
        params.push(hashPassword(flags.password));
      }
      params.push(email);
      await connection.query(`UPDATE app_users SET ${updates.join(", ")} WHERE email = ?`, params);
      console.log(`Updated user ${email} (${tier})`);
    } else {
      await connection.query(
        `INSERT INTO app_users (email, display_name, password_hash, tier, active)
         VALUES (?, ?, ?, ?, ?)`,
        [email, flags.name || email, hashPassword(flags.password), tier, active],
      );
      console.log(`Created user ${email} (${tier})`);
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
