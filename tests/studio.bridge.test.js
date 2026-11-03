"use strict";
/**
 * Proves the stdio -> HTTP bridge really speaks MCP: the same code path Nexora
 * uses against a connected Studio (handshake, tools/list, tools/call, directive).
 * Uses a mock stdio server, so no Studio and no network are needed.
 *
 *   node tests/studio.bridge.test.js
 */

const path = require("path");
const { spawn } = require("child_process");
const studio = require("../server/lib/studio.js");

let passed = 0;
let failed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log("  ok  " + name); })
    .catch((err) => { failed++; console.log("  FAIL " + name + " - " + err.message); });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

const PORT = 18700 + Math.floor(Math.random() * 200);
const MCP_URL = "http://127.0.0.1:" + PORT + "/mcp";
const fixture = path.join(__dirname, "fixtures", "mock-mcp-server.js");
const bridge = path.join(__dirname, "..", "studio", "mcp-http-bridge.js");

function waitForBridge(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge did not start")), 8000);
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) { clearTimeout(timer); resolve(); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error("bridge exited " + code)); });
  });
}

async function main() {
  const proc = spawn(process.execPath, [bridge], {
    env: Object.assign({}, process.env, {
      BRIDGE_PORT: String(PORT),
      BRIDGE_TOKEN: "",
      NEXORA_MCP_COMMAND: process.execPath,
      NEXORA_MCP_ARGS: JSON.stringify([fixture])
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForBridge(proc);

    let tools = [];
    let sessionId = null;

    await check("handshake + tools/list through HTTP", async () => {
      const info = await studio.mcpTools(MCP_URL, 5000);
      tools = info.tools;
      sessionId = info.sessionId;
      assert(tools.length === 4, "expected 4 tools, got " + tools.length);
      assert(tools.some((t) => t.name === "inspect_instance"), "inspect_instance missing");
    });

    await check("tools/call returns real content", async () => {
      const result = await studio.mcpCallTool(MCP_URL, sessionId, "inspect_instance", { path: "Workspace.Cube" }, 5000);
      const text = (result.content || []).map((c) => c.text || "").join("\n");
      assert(text.includes("mock inspect_instance"), "unexpected content: " + text);
      assert(text.includes("Workspace.Cube"), "argument did not reach the server");
    });

    await check("directives resolve to the right tool and answer", async () => {
      const status = { connected: true, kind: "mcp", url: MCP_URL, sessionId: sessionId, tools: tools };
      const out = await studio.runDirective(status, { kind: "tree", arg: "Workspace", raw: "" });
      assert(out.includes("game_tree"), "tree directive picked the wrong tool: " + out.slice(0, 80));
      assert(out.includes("Workspace"), "directive argument missing from result");
    });

    await check("unreachable endpoint is reported, never faked", async () => {
      const status = await studio.probeStatus({ mcpUrl: "http://127.0.0.1:1/mcp", bridgeUrl: "" });
      assert(status.connected === false, "must not claim a connection");
      assert(typeof status.detail === "string" && status.detail.length > 0, "detail must explain why");
    });
  } finally {
    try { proc.kill(); } catch (_e) { /* gone */ }
  }

  console.log("\n" + passed + " studio bridge tests passed" + (failed ? ", " + failed + " failed" : "") + ".");
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("suite crashed: " + err.message);
  process.exitCode = 1;
});
