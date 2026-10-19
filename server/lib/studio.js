"use strict";
/**
 * Nexora AI — Roblox Studio integration layer (Stage 2.5 preparation for Stage 4).
 *
 * Two REAL connection types, both probed live — never simulated:
 *   1. Bridge  — an HTTP endpoint (config: studio.bridgeUrl) that answers with JSON.
 *   2. MCP     — a Model Context Protocol server (config: studio.mcpUrl, or
 *                env NEXORA_MCP_URL) speaking JSON-RPC 2.0 over HTTP.
 *
 * When a connection answers, the model may request real project data with
 * directive lines ([[NEXORA:inspect …]]). Those directives are executed HERE,
 * through the connected tool, and the real result is fed back to the model.
 *
 * If nothing is connected, status is Disconnected and directives are refused —
 * the prompt tells the model to say so instead of pretending to inspect.
 */

const DEFAULT_TIMEOUT_MS = 9000;
const PROBE_TIMEOUT_MS = 900;

let rpcId = 1;

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/* ------------------------------ MCP transport ----------------------------- */

function parseMcpBody(contentType, text) {
  const ct = String(contentType || "");
  if (ct.includes("text/event-stream")) {
    const payloads = text
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    for (let i = payloads.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(payloads[i]);
        if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) return parsed;
      } catch (_e) { /* keep scanning */ }
    }
    return null;
  }
  try { return text ? JSON.parse(text) : null; } catch (_e) { return null; }
}

async function mcpRpc(url, method, params, opts) {
  const options = opts || {};
  const t = withTimeout(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18"
    };
    if (options.sessionId) headers["Mcp-Session-Id"] = options.sessionId;
    const res = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: method, params: params || {} }),
      signal: t.signal
    });
    const text = await res.text();
    const sessionId = res.headers.get("mcp-session-id") || options.sessionId || null;
    const body = parseMcpBody(res.headers.get("content-type"), text);
    if (!res.ok) {
      const message = (body && body.error && (body.error.message || JSON.stringify(body.error))) || text.slice(0, 200) || ("HTTP " + res.status);
      const err = new Error("MCP " + method + " failed: " + message);
      err.status = res.status;
      throw err;
    }
    if (body && body.error) throw new Error("MCP " + method + " error: " + (body.error.message || JSON.stringify(body.error)));
    return { result: body && body.result, sessionId: sessionId };
  } finally {
    t.done();
  }
}

/** Real MCP handshake + tool list. Throws when unreachable/invalid. */
async function mcpTools(url, timeoutMs) {
  const init = await mcpRpc(url, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "nexora-ai", version: "0.3.0" }
  }, { timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS });
  const sessionId = init.sessionId;
  // Notification (no id) — servers that do not require it simply ignore it.
  try {
    await mcpRpc(url, "notifications/initialized", {}, { sessionId: sessionId, timeoutMs: 3000 });
  } catch (_e) { /* optional */ }
  const list = await mcpRpc(url, "tools/list", {}, { sessionId: sessionId, timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS });
  const tools = ((list.result && list.result.tools) || []).map((t) => ({
    name: t.name,
    description: t.description || "",
    inputSchema: t.inputSchema || null
  }));
  return { tools: tools, sessionId: sessionId };
}

async function mcpCallTool(url, sessionId, name, args, timeoutMs) {
  const res = await mcpRpc(url, "tools/call", { name: name, arguments: args || {} }, { sessionId: sessionId, timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS });
  const result = res.result || {};
  if (result.isError) {
    const text = ((result.content || []).map((c) => c.text || "").join("\n") || "tool reported an error");
    throw new Error(text.slice(0, 300));
  }
  return result;
}

/* --------------------------------- probing -------------------------------- */

/** Quick real HTTP probe of a bridge endpoint. */
async function probeBridge(url) {
  if (!url) return null;
  const t = withTimeout(PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" }, signal: t.signal });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_e) { body = null; }
    if (res.ok && body && typeof body === "object") {
      return { connected: true, kind: "bridge", url: url, detail: "bridge responded with JSON" };
    }
    return { connected: false, kind: "bridge", url: url, detail: "bridge answered but not with JSON (HTTP " + res.status + ")" };
  } catch (err) {
    return { connected: false, kind: "bridge", url: url, detail: (err.name === "AbortError" ? "no response within " + PROBE_TIMEOUT_MS + "ms" : String(err.message || err).slice(0, 160)) };
  } finally {
    t.done();
  }
}

/**
 * Live Studio status. Tries MCP first (when configured), then the bridge.
 * Always returns a fresh, honest object.
 */
async function probeStatus(studioCfg) {
  const cfg = studioCfg || {};
  const mcpUrl = String(cfg.mcpUrl || process.env.NEXORA_MCP_URL || "").trim();
  const bridgeUrl = String(cfg.bridgeUrl || "").trim();

  if (mcpUrl) {
    try {
      const info = await mcpTools(mcpUrl, PROBE_TIMEOUT_MS + 1200);
      return {
        connected: true, kind: "mcp", url: mcpUrl,
        detail: "MCP server responded (" + info.tools.length + " tool" + (info.tools.length === 1 ? "" : "s") + " available)",
        tools: info.tools, sessionId: info.sessionId, mcpUrl: mcpUrl, bridgeUrl: bridgeUrl
      };
    } catch (err) {
      const bridge = await probeBridge(bridgeUrl);
      if (bridge && bridge.connected) return Object.assign(bridge, { tools: [], mcpUrl: mcpUrl, bridgeUrl: bridgeUrl });
      return {
        connected: false, kind: "mcp", url: mcpUrl,
        detail: "MCP server unreachable: " + String(err.message || err).slice(0, 180),
        tools: [], mcpUrl: mcpUrl, bridgeUrl: bridgeUrl
      };
    }
  }

  const bridge = (await probeBridge(bridgeUrl)) || { connected: false, kind: "bridge", url: bridgeUrl, detail: "no bridge URL configured" };
  return Object.assign(bridge, { tools: [], mcpUrl: "", bridgeUrl: bridgeUrl });
}

/* -------------------------------- directives ------------------------------ */

const DIRECTIVE_RE = /\[\[NEXORA:(inspect|script|tree|state)\s*([^\]]*)\]\]/gi;

function parseDirectives(text) {
  const out = [];
  let m;
  DIRECTIVE_RE.lastIndex = 0;
  while ((m = DIRECTIVE_RE.exec(String(text || ""))) !== null) {
    out.push({ kind: m[1].toLowerCase(), arg: (m[2] || "").trim(), raw: m[0] });
  }
  return out;
}

function stripDirectives(text) {
  return String(text || "").replace(DIRECTIVE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Score available tool names for a directive kind. */
function pickTool(kind, tools) {
  const list = tools || [];
  const patterns = {
    inspect: [/inspect/i, /instance/i, /describe/i, /get_?object/i],
    script: [/script/i, /source/i, /read/i, /file/i],
    tree: [/tree/i, /hierarch/i, /children/i, /search/i],
    state: [/state/i, /status/i, /game/i, /studio/i]
  }[kind] || [];
  let best = null;
  let bestScore = 0;
  for (const tool of list) {
    const hay = (tool.name + " " + (tool.description || "")).toLowerCase();
    let score = 0;
    patterns.forEach((re, i) => { if (re.test(hay)) score += (10 - i); });
    if (kind === "script" && /script_read|read_script/.test(hay)) score += 8;
    if (kind === "inspect" && /inspect_instance/.test(hay)) score += 8;
    if (kind === "tree" && /game_tree|search_game_tree/.test(hay)) score += 8;
    if (score > bestScore) { bestScore = score; best = tool; }
  }
  return bestScore > 0 ? best : null;
}

function argCandidates(kind, arg) {
  switch (kind) {
    case "inspect": return [{ path: arg }, { instance_path: arg }, { instance: arg }, { target: arg }];
    case "script": return [{ target_file: arg }, { path: arg }, { file_path: arg }, { instance_path: arg }];
    case "tree": return [{ path: arg }, { root: arg }, { instance_path: arg }];
    default: return arg ? [{ path: arg }, {}] : [{}];
  }
}

/** Execute one directive through the connected MCP server. Returns text. */
async function runDirective(studio, directive) {
  if (!studio || !studio.connected) {
    return "[NEXORA] Studio is not connected — nothing could be inspected.";
  }
  const tool = pickTool(directive.kind, studio.tools);
  if (!tool) {
    const names = (studio.tools || []).map((t) => t.name).join(", ") || "none";
    return "[NEXORA] No suitable tool for '" + directive.kind + "' on the connected server. Available tools: " + names + ".";
  }
  const candidates = argCandidates(directive.kind, directive.arg);
  let lastErr = null;
  for (const args of candidates) {
    if (directive.kind !== "state" && !directive.arg && Object.keys(args).length === 0) continue;
    try {
      const result = await mcpCallTool(studio.url, studio.sessionId, tool.name, args, 12000);
      const texts = (result.content || []).filter((c) => c.type === "text" || typeof c.text === "string").map((c) => c.text || "");
      const joined = (texts.join("\n") || JSON.stringify(result).slice(0, 4000)).trim();
      return "[NEXORA] " + directive.kind + " " + (directive.arg || "(current)") + " via " + tool.name + ":\n" + joined.slice(0, 6000);
    } catch (err) {
      lastErr = err;
      continue; // try the next argument shape
    }
  }
  return "[NEXORA] Tool '" + tool.name + "' failed for " + directive.kind + " " + (directive.arg || "") + ": " + String(lastErr && lastErr.message || lastErr).slice(0, 300);
}

module.exports = {
  probeStatus, probeBridge, mcpTools, mcpCallTool,
  parseDirectives, stripDirectives, pickTool, runDirective
};
