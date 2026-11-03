"use strict";
/**
 * Nexora AI - stdio -> HTTP bridge for Roblox Studio's MCP server.
 *
 * Why this exists
 * ---------------
 * Nexora talks to MCP over HTTP JSON-RPC (see server/lib/studio.js). Roblox
 * Studio's built-in MCP server speaks stdio only, so it cannot be connected
 * directly. This bridge starts that stdio server as a child process and exposes
 * it at http://127.0.0.1:8787/mcp - nothing else changes.
 *
 * Usage
 *   node studio/mcp-http-bridge.js
 *
 * Environment
 *   BRIDGE_PORT           HTTP port (default 8787)
 *   BRIDGE_TOKEN          when set, every request must send
 *                         "Authorization: Bearer <token>" (or x-bridge-token)
 *   NEXORA_MCP_COMMAND    executable to run (default: Studio's mcp.bat on Windows,
 *                         /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP on macOS)
 *   NEXORA_MCP_ARGS       JSON array of extra arguments for that executable
 *
 * The bridge binds to 127.0.0.1 only. It is a local helper: do not expose it to
 * the internet. Nexora must be running on the same computer (local mode), or you
 * must tunnel it deliberately at your own risk.
 */

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const TOKEN = String(process.env.BRIDGE_TOKEN || "").trim();
const CALL_TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 30000);

function studioCommand() {
  if (process.env.NEXORA_MCP_COMMAND) {
    let args = [];
    if (process.env.NEXORA_MCP_ARGS) {
      try { args = JSON.parse(process.env.NEXORA_MCP_ARGS); } catch (_e) { args = []; }
      if (!Array.isArray(args)) args = [];
    }
    return { command: process.env.NEXORA_MCP_COMMAND, args: args };
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    return { command: "cmd.exe", args: ["/c", path.join(local, "Roblox", "mcp.bat")] };
  }
  if (process.platform === "darwin") {
    return { command: "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP", args: [] };
  }
  return { command: "node", args: [] };
}

const childInfo = studioCommand();
const child = spawn(childInfo.command, childInfo.args, { stdio: ["pipe", "pipe", "pipe"] });

let buffer = "";
const pending = new Map(); // jsonrpc id -> { resolve, timer }
let nextInternalId = 0;

function settle(id, message) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(message);
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message = null;
    try { message = JSON.parse(line); } catch (_e) { continue; }
    if (message && message.id !== undefined && message.id !== null) settle(message.id, message);
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  const text = String(chunk).trim();
  if (text) process.stderr.write("[studio] " + text + "\n");
});

let childExit = null;
child.on("exit", (code, signal) => {
  childExit = { code: code, signal: signal };
  for (const id of Array.from(pending.keys())) {
    settle(id, { jsonrpc: "2.0", id: id, error: { code: -32000, message: "Studio MCP server exited" } });
  }
  process.stderr.write("[bridge] Studio MCP process exited (" + (signal || code) + ")\n");
});
child.on("error", (err) => {
  childExit = { code: -1, signal: null };
  process.stderr.write("[bridge] cannot start Studio MCP: " + err.message + "\n");
});

/** Forward one JSON-RPC message to stdio and optionally wait for its reply. */
function forward(message) {
  return new Promise((resolve) => {
    const id = message && message.id;
    if (id === undefined || id === null) {
      try { child.stdin.write(JSON.stringify(message) + "\n"); } catch (_e) { /* closing */ }
      resolve(null);
      return;
    }
    const timer = setTimeout(() => settle(id, { jsonrpc: "2.0", id: id, error: { code: -32001, message: "timed out after " + CALL_TIMEOUT_MS + "ms" } }), CALL_TIMEOUT_MS);
    pending.set(id, { resolve: resolve, timer: timer });
    try {
      child.stdin.write(JSON.stringify(message) + "\n");
    } catch (err) {
      settle(id, { jsonrpc: "2.0", id: id, error: { code: -32002, message: "cannot write to Studio MCP: " + err.message } });
    }
  });
}

function authorized(req) {
  if (!TOKEN) return true;
  const header = String(req.headers["x-bridge-token"] || req.headers.authorization || "");
  const value = header.startsWith("Bearer ") ? header.slice(7) : header;
  return value.trim() === TOKEN;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET") {
    send(res, 200, {
      ok: childExit === null,
      bridge: "nexora-studio-mcp",
      endpoint: "/mcp",
      studioProcess: child.pid || null,
      exited: childExit,
      authRequired: !!TOKEN
    });
    return;
  }
  if (req.method !== "POST" || !req.url.startsWith("/mcp")) {
    send(res, 404, { error: "POST /mcp only" });
    return;
  }
  if (!authorized(req)) {
    send(res, 401, { error: "missing or wrong bridge token" });
    return;
  }

  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { raw += chunk; if (raw.length > 4 * 1024 * 1024) req.destroy(); });
  req.on("end", async () => {
    let message;
    try { message = JSON.parse(raw || "{}"); } catch (_e) {
      send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (childExit) {
      send(res, 503, { jsonrpc: "2.0", id: message && message.id !== undefined ? message.id : null, error: { code: -32000, message: "Studio MCP server is not running. Is Studio open with the MCP server enabled?" } });
      return;
    }
    if (Array.isArray(message)) {
      const replies = await Promise.all(message.map(forward));
      send(res, 200, replies.filter(Boolean));
      return;
    }
    const reply = await forward(message);
    if (!reply) { res.writeHead(202); res.end(); return; }
    send(res, 200, reply);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write("[bridge] listening on http://127.0.0.1:" + PORT + "/mcp\n");
  process.stdout.write("[bridge] studio command: " + childInfo.command + " " + childInfo.args.join(" ") + "\n");
  process.stdout.write("[bridge] point Nexora at it:  NEXORA_MCP_URL=http://127.0.0.1:" + PORT + "/mcp\n");
  if (!TOKEN) process.stdout.write("[bridge] note: BRIDGE_TOKEN is not set - any local process can use this port\n");
});

function shutdown() {
  try { child.kill(); } catch (_e) { /* already gone */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
