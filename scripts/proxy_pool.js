#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");
const { URL } = require("node:url");

const DEFAULT_VALIDATE_TARGET = "https://api.ipify.org?format=json";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CONCURRENCY = 20;
const DEFAULT_MAX_FAILURES = 2;
const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 8899;
const USER_AGENT = "aicapex-proxy-pool/0.1";

function usage() {
  return `
Usage:
  node scripts/proxy_pool.js validate --file proxies.txt [options]
  node scripts/proxy_pool.js serve --file proxies.txt --allow-host example.com [options]

Commands:
  validate   Batch-check an authorized proxy list and optionally write healthy proxies.
  serve      Start a local rotating HTTP proxy backed by the healthy entries in a file.

Options:
  --file <path>              Proxy list file. One proxy URL per line.
  --target <url>             Validation URL. Default: ${DEFAULT_VALIDATE_TARGET}
  --concurrency <n>          Parallel validations. Default: ${DEFAULT_CONCURRENCY}
  --timeout-ms <n>           Per-proxy timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --max-failures <n>         Consecutive failures before ejection. Default: ${DEFAULT_MAX_FAILURES}
  --out <path>               For validate: write JSON results.
  --healthy-out <path>       For validate: write healthy proxies as a plain text list.
  --listen <host>            For serve: listen host. Default: ${DEFAULT_LISTEN_HOST}
  --port <n>                 For serve: listen port. Default: ${DEFAULT_LISTEN_PORT}
  --allow-host <host>        For serve: allowed target host. Repeatable. Supports *.example.com.
  --allow-hosts <csv>        For serve: comma-separated allowed target hosts.

Proxy file format:
  http://user:pass@proxy.example.com:8080
  http://proxy.example.com:3128

Only use proxies you own, operate, or are explicitly authorized to use.
`.trim();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const equalIndex = token.indexOf("=");
    let key;
    let value;
    if (equalIndex >= 0) {
      key = token.slice(2, equalIndex);
      value = token.slice(equalIndex + 1);
    } else {
      key = token.slice(2);
      const next = rest[index + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      if (!Array.isArray(flags[key])) flags[key] = [flags[key]];
      flags[key].push(value);
    } else {
      flags[key] = value;
    }
  }

  return { command, flags };
}

function flag(flags, name, fallback = undefined) {
  return Object.prototype.hasOwnProperty.call(flags, name) ? flags[name] : fallback;
}

function scalarFlag(flags, name, fallback = undefined) {
  const value = flag(flags, name, fallback);
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function numberFlag(flags, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = scalarFlag(flags, name, fallback);
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function stringList(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeProxyInput(input) {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function parseProxy(line, lineNumber) {
  const raw = normalizeProxyInput(line);
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`line ${lineNumber}: only http:// and https:// upstream proxies are supported`);
  }
  if (!url.hostname) {
    throw new Error(`line ${lineNumber}: missing proxy host`);
  }

  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`line ${lineNumber}: invalid proxy port`);
  }

  const authHeader =
    url.username || url.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString(
          "base64",
        )}`
      : null;

  const authLabel = url.username ? `${decodeURIComponent(url.username)}:***@` : "";
  const label = `${url.protocol}//${authLabel}${url.hostname}:${port}`;

  return {
    raw,
    url,
    protocol: url.protocol,
    hostname: url.hostname,
    port,
    authHeader,
    label,
  };
}

function loadProxies(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const proxies = [];
  const seen = new Set();

  content.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const proxy = parseProxy(trimmed, index + 1);
    const key = `${proxy.protocol}//${proxy.url.username}:${proxy.url.password}@${proxy.hostname}:${proxy.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      proxies.push(proxy);
    }
  });

  if (!proxies.length) {
    throw new Error(`No proxies found in ${filePath}`);
  }
  return proxies;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function extractIp(body) {
  const text = String(body || "").trim();
  try {
    const parsed = JSON.parse(text);
    return parsed.ip || parsed.origin || null;
  } catch {
    const match = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    return match ? match[0] : null;
  }
}

function openProxySocket(proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      onError(new Error(`proxy socket timeout after ${timeoutMs}ms`));
      socket.destroy();
    }, timeoutMs);

    const socket =
      proxy.protocol === "https:"
        ? tls.connect({ host: proxy.hostname, port: proxy.port, servername: proxy.hostname }, onReady)
        : net.connect({ host: proxy.hostname, port: proxy.port }, onReady);

    socket.once("error", onError);
  });
}

async function establishTunnel(proxy, authority, timeoutMs) {
  const socket = await openProxySocket(proxy, timeoutMs);

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (buffer.length > 64 * 1024) fail(new Error("proxy CONNECT response header too large"));
        return;
      }

      const headerText = buffer.slice(0, headerEnd).toString("latin1");
      const statusMatch = headerText.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
      if (statusCode < 200 || statusCode >= 300) {
        fail(new Error(`proxy CONNECT failed with status ${statusCode || "unknown"}`));
        return;
      }

      settled = true;
      cleanup();
      const extra = buffer.slice(headerEnd + 4);
      if (extra.length) socket.unshift(extra);
      resolve(socket);
    };
    const timer = setTimeout(() => fail(new Error(`proxy CONNECT timeout after ${timeoutMs}ms`)), timeoutMs);

    socket.on("data", onData);
    socket.once("error", onError);

    const headers = [
      `CONNECT ${authority} HTTP/1.1`,
      `Host: ${authority}`,
      "Proxy-Connection: Keep-Alive",
      "Connection: Keep-Alive",
    ];
    if (proxy.authHeader) headers.push(`Proxy-Authorization: ${proxy.authHeader}`);
    socket.write(`${headers.join("\r\n")}\r\n\r\n`);
  });
}

function decodeChunkedBody(body) {
  let offset = 0;
  const chunks = [];

  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const sizeText = body.slice(offset, lineEnd).toString("ascii").split(";")[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) break;
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(body.slice(offset, offset + size));
    offset += size + 2;
  }

  return Buffer.concat(chunks);
}

function parseRawHttpResponse(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    throw new Error("upstream response did not include complete headers");
  }

  const headerText = buffer.slice(0, headerEnd).toString("latin1");
  const lines = headerText.split("\r\n");
  const statusMatch = lines[0].match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
  const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
  const headers = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index > 0) {
      const key = line.slice(0, index).trim().toLowerCase();
      const value = line.slice(index + 1).trim();
      headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
    }
  }

  let bodyBuffer = buffer.slice(headerEnd + 4);
  if (/\bchunked\b/i.test(headers["transfer-encoding"] || "")) {
    bodyBuffer = decodeChunkedBody(bodyBuffer);
  }

  return {
    statusCode,
    headers,
    body: bodyBuffer.toString("utf8"),
  };
}

function requestHttpThroughProxy(proxy, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = proxy.protocol === "https:" ? https : http;
    const headers = {
      Host: target.host,
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      Connection: "close",
    };
    if (proxy.authHeader) headers["Proxy-Authorization"] = proxy.authHeader;

    const request = client.request(
      {
        host: proxy.hostname,
        port: proxy.port,
        method: "GET",
        path: target.href,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => {
          chunks.push(chunk);
          if (Buffer.concat(chunks).length > 2 * 1024 * 1024) {
            request.destroy(new Error("validation response exceeded 2MB"));
          }
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`validation timeout after ${timeoutMs}ms`)));
    request.once("error", reject);
    request.end();
  });
}

async function requestHttpsThroughProxy(proxy, target, timeoutMs) {
  const authority = `${target.hostname}:${target.port || 443}`;
  const socket = await establishTunnel(proxy, authority, timeoutMs);

  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
      const requestPath = `${target.pathname || "/"}${target.search || ""}`;
      tlsSocket.write(
        [
          `GET ${requestPath} HTTP/1.1`,
          `Host: ${target.host}`,
          `User-Agent: ${USER_AGENT}`,
          "Accept: */*",
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
    });

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => {
        tlsSocket.destroy();
        reject(new Error(`validation timeout after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    tlsSocket.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 2 * 1024 * 1024) {
        finish(() => {
          tlsSocket.destroy();
          reject(new Error("validation response exceeded 2MB"));
        });
      }
    });
    tlsSocket.once("end", () => {
      finish(() => {
        try {
          resolve(parseRawHttpResponse(Buffer.concat(chunks)));
        } catch (error) {
          reject(error);
        }
      });
    });
    tlsSocket.once("error", (error) => {
      finish(() => reject(error));
    });
  });
}

function requestThroughProxy(proxy, target, timeoutMs) {
  if (target.protocol === "http:") return requestHttpThroughProxy(proxy, target, timeoutMs);
  if (target.protocol === "https:") return requestHttpsThroughProxy(proxy, target, timeoutMs);
  throw new Error(`unsupported validation protocol: ${target.protocol}`);
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function validateCommand(flags) {
  const filePath = scalarFlag(flags, "file");
  if (!filePath) throw new Error("--file is required");

  const target = new URL(String(scalarFlag(flags, "target", DEFAULT_VALIDATE_TARGET)));
  const timeoutMs = numberFlag(flags, "timeout-ms", DEFAULT_TIMEOUT_MS, { min: 500, max: 120000 });
  const concurrency = numberFlag(flags, "concurrency", DEFAULT_CONCURRENCY, { min: 1, max: 500 });
  const proxies = loadProxies(filePath);

  console.log(`Validating ${proxies.length} proxies against ${target.href}`);

  const results = await mapLimit(proxies, concurrency, async (proxy) => {
    const started = Date.now();
    try {
      const response = await requestThroughProxy(proxy, target, timeoutMs);
      const elapsedMs = Date.now() - started;
      const ok = response.statusCode >= 200 && response.statusCode < 400;
      return {
        ok,
        proxy: proxy.raw,
        label: proxy.label,
        statusCode: response.statusCode,
        elapsedMs,
        exitIp: extractIp(response.body),
        error: ok ? null : `unexpected HTTP status ${response.statusCode}`,
      };
    } catch (error) {
      return {
        ok: false,
        proxy: proxy.raw,
        label: proxy.label,
        statusCode: null,
        elapsedMs: Date.now() - started,
        exitIp: null,
        error: error.message,
      };
    }
  });

  const healthy = results.filter((result) => result.ok);
  const failed = results.length - healthy.length;
  const output = {
    generatedAt: new Date().toISOString(),
    target: target.href,
    total: results.length,
    healthy: healthy.length,
    failed,
    results,
    healthyProxies: healthy.map((result) => result.proxy),
  };

  const outPath = scalarFlag(flags, "out");
  if (outPath) {
    writeJson(String(outPath), output);
    console.log(`Wrote ${outPath}`);
  }
  const healthyOutPath = scalarFlag(flags, "healthy-out");
  if (healthyOutPath) {
    writeText(String(healthyOutPath), `${healthy.map((result) => result.proxy).join("\n")}\n`);
    console.log(`Wrote ${healthyOutPath}`);
  }

  console.log(`Healthy: ${healthy.length}/${results.length}; failed: ${failed}`);
  for (const result of results) {
    const status = result.ok ? "OK" : "FAIL";
    const ip = result.exitIp ? ` ip=${result.exitIp}` : "";
    const error = result.error ? ` error=${result.error}` : "";
    console.log(`${status} ${result.label} ${result.elapsedMs}ms${ip}${error}`);
  }

  if (!healthy.length) process.exitCode = 2;
}

function stripHopByHopHeaders(headers) {
  const stripped = { ...headers };
  for (const key of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete stripped[key];
  }
  return stripped;
}

function parseAuthority(authority) {
  const value = String(authority || "").trim();
  if (!value) throw new Error("missing CONNECT authority");

  if (value.startsWith("[")) {
    const match = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!match) throw new Error(`invalid CONNECT authority: ${value}`);
    return {
      hostname: match[1].toLowerCase(),
      port: Number(match[2] || 443),
      authority: `[${match[1]}]:${Number(match[2] || 443)}`,
    };
  }

  const lastColon = value.lastIndexOf(":");
  const hostname = lastColon >= 0 ? value.slice(0, lastColon) : value;
  const port = lastColon >= 0 ? Number(value.slice(lastColon + 1)) : 443;
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid CONNECT authority: ${value}`);
  }

  return {
    hostname: hostname.toLowerCase(),
    port,
    authority: `${hostname}:${port}`,
  };
}

function compileAllowedHosts(flags) {
  const hosts = new Set([...stringList(flag(flags, "allow-host")), ...stringList(flag(flags, "allow-hosts"))]);
  if (!hosts.size) {
    throw new Error("serve requires --allow-host or --allow-hosts to bound outbound destinations");
  }
  return [...hosts];
}

function isHostAllowed(hostname, allowedHosts) {
  const host = String(hostname || "").toLowerCase();
  return allowedHosts.some((allowed) => {
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === allowed;
  });
}

class ProxyPool {
  constructor(proxies, { maxFailures }) {
    this.entries = proxies.map((proxy, index) => ({
      id: index + 1,
      proxy,
      consecutiveFailures: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      dead: false,
      lastError: null,
      lastFailureAt: null,
      lastSuccessAt: null,
    }));
    this.cursor = 0;
    this.maxFailures = maxFailures;
  }

  next() {
    const alive = this.entries.filter((entry) => !entry.dead);
    if (!alive.length) {
      throw new Error("all proxies have been ejected");
    }

    for (let checked = 0; checked < this.entries.length; checked += 1) {
      const entry = this.entries[this.cursor];
      this.cursor = (this.cursor + 1) % this.entries.length;
      if (!entry.dead) return entry;
    }

    throw new Error("no eligible proxy available");
  }

  markSuccess(entry) {
    entry.totalSuccesses += 1;
    entry.consecutiveFailures = 0;
    entry.lastError = null;
    entry.lastSuccessAt = new Date().toISOString();
  }

  markFailure(entry, error) {
    entry.totalFailures += 1;
    entry.consecutiveFailures += 1;
    entry.lastError = error.message;
    entry.lastFailureAt = new Date().toISOString();
    if (entry.consecutiveFailures >= this.maxFailures) {
      entry.dead = true;
      console.warn(`Ejected proxy ${entry.proxy.label}: ${error.message}`);
    }
  }

  snapshot() {
    return this.entries.map((entry) => ({
      id: entry.id,
      proxy: entry.proxy.label,
      dead: entry.dead,
      consecutiveFailures: entry.consecutiveFailures,
      totalFailures: entry.totalFailures,
      totalSuccesses: entry.totalSuccesses,
      lastError: entry.lastError,
      lastFailureAt: entry.lastFailureAt,
      lastSuccessAt: entry.lastSuccessAt,
    }));
  }
}

function respondJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function forwardHttpRequest(request, response, target, pool, timeoutMs) {
  let entry;
  try {
    entry = pool.next();
  } catch (error) {
    respondJson(response, 503, { error: error.message });
    return;
  }

  const proxy = entry.proxy;
  const client = proxy.protocol === "https:" ? https : http;
  const headers = stripHopByHopHeaders(request.headers);
  headers.host = target.host;
  if (proxy.authHeader) headers["Proxy-Authorization"] = proxy.authHeader;

  const upstream = client.request(
    {
      host: proxy.hostname,
      port: proxy.port,
      method: request.method,
      path: target.href,
      headers,
    },
    (upstreamResponse) => {
      pool.markSuccess(entry);
      response.writeHead(upstreamResponse.statusCode || 502, stripHopByHopHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    },
  );

  upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error(`upstream proxy timeout after ${timeoutMs}ms`)));
  upstream.once("error", (error) => {
    pool.markFailure(entry, error);
    if (!response.headersSent) {
      respondJson(response, 502, { error: "proxy request failed", proxy: proxy.label, detail: error.message });
    } else {
      response.destroy(error);
    }
  });

  request.pipe(upstream);
}

function handleConnect(request, clientSocket, head, allowedHosts, pool, timeoutMs) {
  let parsed;
  try {
    parsed = parseAuthority(request.url);
  } catch (error) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  if (!isHostAllowed(parsed.hostname, allowedHosts)) {
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }

  let entry;
  try {
    entry = pool.next();
  } catch (error) {
    clientSocket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }

  establishTunnel(entry.proxy, parsed.authority, timeoutMs)
    .then((proxySocket) => {
      pool.markSuccess(entry);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) proxySocket.write(head);
      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);
    })
    .catch((error) => {
      pool.markFailure(entry, error);
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
}

function serveCommand(flags) {
  const filePath = scalarFlag(flags, "file");
  if (!filePath) throw new Error("--file is required");

  const listenHost = String(scalarFlag(flags, "listen", DEFAULT_LISTEN_HOST));
  const listenPort = numberFlag(flags, "port", DEFAULT_LISTEN_PORT, { min: 1, max: 65535 });
  const timeoutMs = numberFlag(flags, "timeout-ms", DEFAULT_TIMEOUT_MS, { min: 500, max: 120000 });
  const maxFailures = numberFlag(flags, "max-failures", DEFAULT_MAX_FAILURES, { min: 1, max: 100 });
  const allowedHosts = compileAllowedHosts(flags);
  const proxies = loadProxies(filePath);
  const pool = new ProxyPool(proxies, { maxFailures });

  const server = http.createServer((request, response) => {
    if (request.url === "/status") {
      respondJson(response, 200, {
        ok: true,
        allowedHosts,
        proxies: pool.snapshot(),
      });
      return;
    }

    let target;
    try {
      target = new URL(request.url);
    } catch {
      respondJson(response, 400, { error: "expected absolute-form proxy request URL or /status" });
      return;
    }

    if (!["http:", "https:"].includes(target.protocol)) {
      respondJson(response, 400, { error: "only http:// and https:// target URLs are supported" });
      return;
    }
    if (!isHostAllowed(target.hostname, allowedHosts)) {
      respondJson(response, 403, { error: "target host is not in allowlist" });
      return;
    }

    forwardHttpRequest(request, response, target, pool, timeoutMs);
  });

  server.on("connect", (request, clientSocket, head) => {
    handleConnect(request, clientSocket, head, allowedHosts, pool, timeoutMs);
  });

  server.on("clientError", (error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  server.listen(listenPort, listenHost, () => {
    console.log(`Rotating proxy listening on http://${listenHost}:${listenPort}`);
    console.log(`Loaded proxies: ${proxies.length}; max failures before ejection: ${maxFailures}`);
    console.log(`Allowed hosts: ${allowedHosts.join(", ")}`);
    console.log(`Status: http://${listenHost}:${listenPort}/status`);
  });

  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
  });
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h" || flag(flags, "help")) {
    console.log(usage());
    return;
  }

  if (command === "validate") {
    await validateCommand(flags);
    return;
  }
  if (command === "serve") {
    serveCommand(flags);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
