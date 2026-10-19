"use strict";
/**
 * Nexora AI — production (public deployment) behaviour test.
 *
 * Starts the server the way a host does (platform PORT, NEXORA_PUBLIC=1,
 * trusted proxy) and verifies the hardening that a public deployment needs:
 *   1. Binds the platform-provided PORT and reports publicDeployment=true.
 *   2. HSTS is sent when secure/public mode is on.
 *   3. Provider writes are refused (READ_ONLY_DEPLOYMENT) — config is env-driven.
 *   4. An env-managed provider key is used but NEVER written to disk.
 *   5. Studio tool calls are locked without the shared token, allowed with it.
 *   6. X-Forwarded-For is honoured for rate-limit identity (proxy-aware IP).
 */
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

const MCP_PORT = 9338;
const SERVER_PORT = 9339;
const STUDIO_TOKEN = "test-studio-token-123";
const GEMINI_KEY = "AIzaFAKE0000000000000000000000000000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(label) { passed += 1; console.log("  ok  " + label); }
function fail(label, detail) { console.error("  FAIL " + label + ": " + detail); process.exitCode = 1; }

function httpJson(port, method, urlPath, payload, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: port, method: method, path: urlPath, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let body = null;
          try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null; } catch (_e) { body = null; }
          resolve({ status: res.statusCode, body: body, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("request timeout")); });
    if (payload) req.write(JSON.stringify(payload));
    req.end();
  });
}

function startStubMcp() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_e) { body = null; }
        res.setHeader("Content-Type", "application/json");
        if (body && body.method === "initialize") { res.setHeader("Mcp-Session-Id", "s"); res.writeHead(200); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })); return; }
        if (body && body.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
        if (body && body.method === "tools/list") { res.writeHead(200); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "inspect_instance", description: "inspect" }] } })); return; }
        if (body && body.method === "tools/call") { res.writeHead(200); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "stub output" }] } })); return; }
        res.writeHead(404); res.end("{}");
      });
    });
    server.listen(MCP_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  const mcp = await startStubMcp();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-prod-"));
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_ENV: "production",
    PORT: String(SERVER_PORT),            // platform-managed port
    NEXORA_PUBLIC: "1",
    NEXORA_TRUST_PROXY: "1",
    NEXORA_CONFIG_DIR: configDir,
    NEXORA_STUDIO_TOKEN: STUDIO_TOKEN,
    NEXORA_MCP_URL: "http://127.0.0.1:" + MCP_PORT,
    NEXORA_PROVIDER: "gemini",
    NEXORA_GEMINI_KEY: GEMINI_KEY
  };
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "server.js")], { env: env, stdio: ["ignore", "pipe", "pipe"] });
  let bootLog = "";
  child.stdout.on("data", (d) => { bootLog += String(d); });
  child.stderr.on("data", () => {});

  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      try { await httpJson(SERVER_PORT, "GET", "/api/health", null); up = true; break; } catch (_e) { await sleep(200); }
    }
    if (!up) { fail("server did not bind PORT " + SERVER_PORT, bootLog.slice(0, 300)); }
    else {
      const health = await httpJson(SERVER_PORT, "GET", "/api/health", null);
      if (health.body && health.body.status === "ok" && health.body.publicDeployment === true && health.body.managedPort === true) {
        ok("binds the platform PORT and reports publicDeployment + managedPort");
      } else fail("health flags", JSON.stringify(health.body));

      if (health.headers && /max-age=\d+/.test(String(health.headers["strict-transport-security"] || ""))) {
        ok("HSTS header present on responses in public mode");
      } else fail("HSTS", JSON.stringify(health.headers && health.headers["strict-transport-security"]));

      const providers = await httpJson(SERVER_PORT, "GET", "/api/providers", null);
      const gem = providers.body && providers.body.providers && providers.body.providers.gemini;
      if (gem && gem.hasKey === true && gem.keySource === "env") ok("env-provided key is active and labelled keySource=env");
      else fail("env key view", JSON.stringify(gem));

      const blocked = await httpJson(SERVER_PORT, "POST", "/api/providers", { provider: "gemini", apiKey: "AIzaSOMETHINGELSE" }, null);
      if (blocked.status === 403 && blocked.body && blocked.body.error && blocked.body.error.code === "READ_ONLY_DEPLOYMENT") {
        ok("provider writes refused in public mode (READ_ONLY_DEPLOYMENT)");
      } else fail("read-only guard", blocked.status + " " + JSON.stringify(blocked.body));

      const locked = await httpJson(SERVER_PORT, "POST", "/api/studio/mcp/call", { tool: "inspect_instance", args: {} }, null);
      if (locked.status === 403 && locked.body && locked.body.error && locked.body.error.code === "STUDIO_LOCKED") {
        ok("Studio tool calls locked without the shared token");
      } else fail("studio lock", locked.status + " " + JSON.stringify(locked.body));

      const allowed = await httpJson(SERVER_PORT, "POST", "/api/studio/mcp/call", { tool: "inspect_instance", args: {} }, { "X-Nexora-Studio-Token": STUDIO_TOKEN });
      if (allowed.status === 200 && allowed.body && allowed.body.ok === true) ok("Studio tool call succeeds with the correct token");
      else fail("studio token", allowed.status + " " + JSON.stringify(allowed.body));

      const wrongToken = await httpJson(SERVER_PORT, "POST", "/api/studio/mcp/call", { tool: "inspect_instance", args: {} }, { "X-Nexora-Studio-Token": "wrong" });
      if (wrongToken.status === 403) ok("a wrong Studio token is rejected");
      else fail("wrong token", wrongToken.status);

      // Proxy-aware identity: many requests from one X-Forwarded-For address hit the limiter.
      let limited = false;
      for (let i = 0; i < 200; i++) {
        const r = await httpJson(SERVER_PORT, "GET", "/api/providers", null, { "X-Forwarded-For": "203.0.113.55" });
        if (r.status === 429) { limited = true; break; }
      }
      if (limited) ok("rate limiter keys on the proxied client IP (X-Forwarded-For)");
      else fail("proxy-aware limiter", "no 429 within 200 requests");

      // The env key must never be persisted to disk.
      const diskPath = path.join(configDir, "settings.json");
      const disk = fs.existsSync(diskPath) ? fs.readFileSync(diskPath, "utf8") : "";
      if (disk && disk.indexOf(GEMINI_KEY) === -1) ok("env-managed key is never written to config/settings.json");
      else fail("key persisted to disk", "settings.json contains the env key");

      console.log("\n" + passed + " production mode tests passed." + (process.exitCode ? " (with failures)" : ""));
    }
  } catch (err) {
    if (!process.exitCode) process.exitCode = 1;
    console.error("production test error: " + (err && err.message));
  } finally {
    try { child.kill(); } catch (_e) { /* gone */ }
    try { mcp.close(); } catch (_e) { /* gone */ }
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    process.exit(process.exitCode || 0);
  }
}

main();
