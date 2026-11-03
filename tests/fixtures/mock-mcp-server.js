"use strict";
/**
 * Minimal stdio MCP server used by tests/studio.bridge.test.js to prove the
 * bridge forwards a real MCP handshake, tool list, and tool call.
 * Not used by the app.
 */

const readline = require("readline");

const TOOLS = [
  { name: "inspect_instance", description: "Inspect an instance", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "script_read", description: "Read a script source", inputSchema: { type: "object", properties: { target_file: { type: "string" } } } },
  { name: "game_tree", description: "List the hierarchy", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "search_asset", description: "Search assets", inputSchema: { type: "object", properties: {} } }
];

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try { message = JSON.parse(text); } catch (_e) { return; }

  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: result }) + "\n");

  switch (message.method) {
    case "initialize":
      reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-studio", version: "1.0.0" } });
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      reply({ tools: TOOLS });
      return;
    case "tools/call": {
      const name = message.params && message.params.name;
      const args = (message.params && message.params.arguments) || {};
      const text = "mock " + name + " path=" + (args.path || args.target_file || args.instance_path || "none");
      reply({ content: [{ type: "text", text: text }], isError: false });
      return;
    }
    default:
      if (message.id !== undefined) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } }) + "\n");
      }
  }
});
