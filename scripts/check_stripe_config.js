#!/usr/bin/env node
"use strict";

const path = require("node:path");

const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

function present(name) {
  return Boolean(String(process.env[name] || "").trim());
}

function masked(value) {
  const text = String(value || "");
  if (!text) return "";
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function requirePrefix(name, prefix) {
  const value = String(process.env[name] || "").trim();
  if (!value) return { ok: false, message: `${name} is missing` };
  if (!value.startsWith(prefix)) return { ok: false, message: `${name} should start with ${prefix}` };
  return { ok: true, message: `${name} present (${masked(value)})` };
}

async function fetchStripePrice(name, priceId, expectedType = "recurring") {
  const secret = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secret || !priceId) return null;
  const response = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, message: `${name} could not be fetched: ${body.error?.message || response.status}` };
  }
  if (!body.active) return { ok: false, message: `${name} is not active` };
  if (body.type !== expectedType) return { ok: false, message: `${name} must be a ${expectedType} price` };
  if (expectedType === "recurring" && body.recurring?.interval !== "month") {
    return { ok: false, message: `${name} must be a monthly recurring price` };
  }
  return {
    ok: true,
    message: `${name} active ${body.type} price (${body.currency || "unknown"} ${body.unit_amount ?? "unknown"})`,
  };
}

async function main() {
  const checks = [
    requirePrefix("STRIPE_PUBLISHABLE_KEY", "pk_"),
    requirePrefix("STRIPE_SECRET_KEY", "sk_"),
    requirePrefix("STRIPE_PRICE_PRO", "price_"),
    requirePrefix("STRIPE_PRICE_ENTERPRISE", "price_"),
    requirePrefix("STRIPE_PRICE_PRO_ONE_TIME", "price_"),
    requirePrefix("STRIPE_PRICE_ENTERPRISE_ONE_TIME", "price_"),
    requirePrefix("STRIPE_WEBHOOK_SECRET", "whsec_"),
  ];

  for (const [name, expectedType] of [
    ["STRIPE_PRICE_PRO", "recurring"],
    ["STRIPE_PRICE_ENTERPRISE", "recurring"],
    ["STRIPE_PRICE_PRO_ONE_TIME", "one_time"],
    ["STRIPE_PRICE_ENTERPRISE_ONE_TIME", "one_time"],
  ]) {
    const remote = await fetchStripePrice(name, String(process.env[name] || "").trim(), expectedType);
    if (remote) checks.push(remote);
  }

  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? "OK" : "FAIL"} ${check.message}`);
  }

  if (!present("STRIPE_SECRET_KEY")) {
    console.log("INFO remote Stripe price validation skipped because STRIPE_SECRET_KEY is missing");
  }

  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(`FAIL ${error.message || error}`);
  process.exit(1);
});
