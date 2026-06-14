#!/usr/bin/env node
"use strict";

const mysql = require("mysql2/promise");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const database = process.argv[2] || process.env.MYSQL_DATABASE;
  const sql = await readStdin();
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database,
    charset: "utf8mb4",
    multipleStatements: true,
    decimalNumbers: true,
  });

  try {
    const [result] = await connection.query(sql);
    if (/^\s*select\b/i.test(sql)) {
      const rows = Array.isArray(result) ? result : [];
      if (rows.length) {
        const columns = Object.keys(rows[0]);
        process.stdout.write(`${columns.join("\t")}\n`);
        for (const row of rows) {
          process.stdout.write(`${columns.map((column) => row[column] ?? "").join("\t")}\n`);
        }
      }
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  const message = String(error.stack || error.message || error).replace(process.env.MYSQL_PASSWORD || "", "***");
  console.error(message);
  process.exit(1);
});
