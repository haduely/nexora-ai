"use strict";
/**
 * Nexora AI — MCP protocol integration test.
 *
 * Spins up a REAL Model Context Protocol server (JSON-RPC 2.0 over HTTP) that
 * implements initialize / notifications/initialized / tools/list / tools/call,
 * then starts Nexora with NEXORA_MCP_URL pointed at it and verifies:
 *   1. Studio status reports Connected with the stub's tools (a live probe).
 *   2. GET /api/studio/mcp/tools returns those tools.
 *   3. POST /api/studio/mcp/call executes a tool and returns its real output.
 *   4. The directive runner (lib/studio.runDirective) executes through the stub.
 *   5. With no server listening, status is honestly Disconnected.
 *
 * This proves the MCP client is a genuine protocol implementation. It does NOT
 * prove Roblox Studio itself is connected — that needs a real Studio MCP.
 */
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

const MCP_PORT = 9336;
const SERVER_PORT = 9337;
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
          resolve({ status: res.statusCode, body: body });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("request timeout")); });
    if (payload) req.write(JSON.stringify(payload));
    req.end();
  });
}

const TOOLS = [
  { name: "inspect_instance", description: "Inspect one instance in the open place", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "roblox_studio_get_studio_state", description: "Report current Studio state", inputSchema: { type: "object", properties: {} } }
];

function startStubMcp() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_e) { body = null; }
        const method = body && body.method;
        res.setHeader("Content-Type", "application/json");
        if (method === "initialize") {
          res.setHeader("Mcp-Session-Id", "stub-session");
          res.writeHead(200);
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "nexora-stub-studio", version: "1.0.0" } } }));
          return;
        }
        if (method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
        if (method === "tools/list") {
          res.writeHead(200);
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: TOOLS } }));
          return;
        }
        if (method === "tools/call") {
          const name = body.params && body.params.name;
          const args = (body.params && body.params.arguments) || {};
          if (name === "inspect_instance" && !args.path) {
            res.writeHead(200);
            res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "missing required argument: path" }] } }));
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify({
            jsonrpc: "2.0", id: body.id,
            result: {
              content: [{ type: "text", text: name === "inspect_instance"
                ? "Workspace.Baseplate — ClassName Part, Anchored=true, Size=512,20,512"
                : "Studio state: 1 place open, mode=Edit" }]
            }
          }));
          return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body && body.id, error: { code: -32601, message: "unknown method" } }));
      });
    });
    server.listen(MCP_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  const mcp = await startStubMcp();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-mcp-"));
  const env = Object.assign({}, process.env, {
    NEXORA_CONFIG_DIR: configDir,
    NEXORA_MCP_URL: "http://127.0.0.1:" + MCP_PORT,
    NEXORA_PORT: String(SERVER_PORT),
    NEXORA_PUBLIC: "0",
    NEXORA_TRUST_PROXY: "0"
  });
  delete env.PORT;
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "server.js")], { env: env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});

  try {
    for (let i = 0; i < 40; i++) {
      try { await httpJson(SERVER_PORT, "GET", "/api/health", null); break; } catch (_e) { await sleep(200); }
    }

    const status = await httpJson(SERVER_PORT, "GET", "/api/studio/status?refresh=1", null);
    if (status.body && status.body.connected === true && status.body.kind === "mcp") ok("live MCP probe reports Connected (kind=mcp)");
    else fail("studio status", JSON.stringify(status.body));
    if (status.body && status.body.toolCount === TOOLS.length) ok("status lists " + TOOLS.length + " real tools from the MCP server");
    else fail("tool count", JSON.stringify(status.body));

    const tools = await httpJson(SERVER_PORT, "GET", "/api/studio/mcp/tools", null);
    if (tools.status === 200 && tools.body && tools.body.tools.length === TOOLS.length) ok("/api/studio/mcp/tools returns the stub tool list");
    else fail("tools route", tools.status + " " + JSON.stringify(tools.body));

    const call = await httpJson(SERVER_PORT, "POST", "/api/studio/mcp/call", { tool: "inspect_instance", args: { path: "Workspace.Baseplate" } }, null);
    if (call.status === 200 && call.body && /Workspace\.Baseplate/.test(call.body.output || "")) ok("tool proxy returns the stub's real output");
    else fail("tool call", call.status + " " + JSON.stringify(call.body));

    const unknown = await httpJson(SERVER_PORT, "POST", "/api/studio/mcp/call", { tool: "not_a_real_tool", args: {} }, null);
    if (unknown.status === 400) ok("unknown tool is rejected (400), not silently accepted");
    else fail("unknown tool", unknown.status + " " + JSON.stringify(unknown.body));

    // Direct module check: the directive runner fills argument shapes and executes.
    const studio = require(path.join(__dirname, "..", "server", "lib", "studio.js"));
    const live = await studio.probeStatus({ mcpUrl: "http://127.0.0.1:" + MCP_PORT, bridgeUrl: "" });
    const out = await studio.runDirective(live, { kind: "inspect", arg: "Workspace.Baseplate" });
    if (/Workspace\.Baseplate/.test(out) && /inspect_instance/.test(out)) ok("runDirective executes a real tool call and returns its content");
    else fail("runDirective", out.slice(0, 200));

    const pick = studio.pickTool("state", live.tools);
    if (pick && pick.name === "roblox_studio_get_studio_state") ok("tool selection matches the directive kind");
    else fail("pickTool", JSON.stringify(pick));

    child.kill();
    mcp.close();

    // Honest disconnected behaviour: nothing listening on that port.
    mcp.close();
    await sleep(300);
    const down = await studio.probeStatus({ mcpUrl: "http://127.0.0.1:" + MCP_PORT, bridgeUrl: "" });
    if (down.connected === false) ok("no server listening → status is honestly Disconnected");
    else fail("disconnected probe", JSON.stringify(down));

    console.log("\n" + passed + " MCP protocol tests passed." + (process.exitCode ? " (with failures)" : ""));
  } catch (err) {
    if (!process.exitCode) process.exitCode = 1;
    console.error("MCP stub test error: " + (err && err.message));
    try { child.kill(); } catch (_e) { /* gone */ }
    try { mcp.close(); } catch (_e) { /* gone */ }
  } finally {
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    process.exit(process.exitCode || 0);
  }
}

main();
