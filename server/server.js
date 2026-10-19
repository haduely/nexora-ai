"use strict";
/**
 * Nexora AI — local application server.
 * Zero dependencies (Node 18+). Serves the interface and a JSON API.
 * All AI provider traffic goes through this process, so credentials never
 * reach the browser, and every capability is gated in one place.
 *
 * Stage 2 (current): real AI chat via /api/chat with provider adapters
 * (Gemini, Ollama, OpenAI-compatible, Pollinations keyless), project-aware
 * Studio/MCP probing, and static Roblox verification with automatic repair.
 */
const http = require("http");

const config = require("./config");
const staticFiles = require("./static");
const ai = require("./lib/ai");
const promptLib = require("./lib/prompt");
const verifier = require("./lib/verify");
const studio = require("./lib/studio");

const VERSION = "0.3.0";
const STAGE = 2;
/**
 * Bind/port resolution.
 *  - NEXORA_HOST / NEXORA_PORT   explicit overrides (local use)
 *  - PORT                         set by hosting platforms (Render, Railway, …)
 * A platform-managed PORT means we are deployed, so we bind all interfaces
 * by default; locally we stay on the loopback address.
 */
const MANAGED_PORT = process.env.PORT !== undefined && String(process.env.PORT).trim() !== "";
const PORT = Number(MANAGED_PORT ? process.env.PORT : process.env.NEXORA_PORT || 7810);
const HOST = process.env.NEXORA_HOST || (MANAGED_PORT ? "0.0.0.0" : "127.0.0.1");

/**
 * Public deployment mode. Turns on HTTPS/HSTS hardening, makes provider
 * credentials environment-only, and closes unauthenticated Studio tool calls.
 */
const PUBLIC_MODE = /^(1|true|yes)$/i.test(String(process.env.NEXORA_PUBLIC || ""));
const ALLOW_CONFIG_WRITE = /^(1|true|yes)$/i.test(String(process.env.NEXORA_ALLOW_CONFIG_WRITE || ""));
/** Shared secret required for Studio tool calls while in public mode. */
const STUDIO_TOKEN = String(process.env.NEXORA_STUDIO_TOKEN || "").trim();
/**
 * Trust X-Forwarded-For (platform proxies terminate TLS in front of us).
 * Enabled by default when a platform manages the port.
 */
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.NEXORA_TRUST_PROXY || (MANAGED_PORT ? "1" : "0")));
const startedAt = Date.now();

/** Real client IP — honours X-Forwarded-For only when the proxy is trusted. */
function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
    const real = String(req.headers["x-real-ip"] || "").trim();
    if (real) return real;
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

/** Constant-time-ish comparison for the Studio token. */
function tokenMatches(candidate) {
  const given = String(candidate || "");
  if (!STUDIO_TOKEN || given.length !== STUDIO_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ STUDIO_TOKEN.charCodeAt(i);
  return diff === 0;
}

staticFiles.setSecure(PUBLIC_MODE || TRUST_PROXY);

const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGE_CHARS = 8000;
const MAX_HISTORY_MESSAGES = 60;

/* ------------------------- config with mtime cache --------------------- */
let cfgCache = { mtimeMs: -1, value: null };

function currentConfig() {
  try {
    const mtimeMs = config.statMtimeMs();
    if (cfgCache.value && cfgCache.mtimeMs === mtimeMs) return cfgCache.value;
    const value = config.load();
    cfgCache = { mtimeMs: mtimeMs, value: value };
    return value;
  } catch (_e) {
    return cfgCache.value || config.load();
  }
}
function saveConfig(next) {
  config.save(next);
  cfgCache = { mtimeMs: config.statMtimeMs(), value: next };
  return next;
}

/* ------------------------------------------------------------------ */
/* Minimal per-IP rate limiter (requests / window).                   */
/* ------------------------------------------------------------------ */
const RATE_WINDOW_MS = 60_000;

function makeLimiter(max, windowMs) {
  const hits = new Map();
  return function rateLimited(ip) {
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { count: 0, windowStart: now };
      hits.set(ip, entry);
    }
    entry.count += 1;
    if (hits.size > 500) {
      for (const [key, val] of hits) {
        if (now - val.windowStart > windowMs) hits.delete(key);
      }
    }
    return entry.count > max;
  };
}

const apiRateLimited = makeLimiter(180, RATE_WINDOW_MS);
const chatRateLimited = makeLimiter(30, RATE_WINDOW_MS);

/* ------------------------------------------------------------------ */
/* Request helpers                                                     */
/* ------------------------------------------------------------------ */

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ai.AiError("Request body too large.", { status: 413, code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object") throw new Error("not an object");
        resolve(parsed);
      } catch (_e) {
        reject(new ai.AiError("Invalid JSON body.", { status: 400, code: "BAD_JSON" }));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

function publicProviderView(cfg) {
  const out = { active: null, providers: {} };
  for (const [id, adapter] of Object.entries(ai.PROVIDERS)) {
    const stored = (cfg.providers && cfg.providers[id]) || {};
    const key = String(stored.apiKey || "");
    const model = stored.model || adapter.defaultModel || "";
    const configured = adapter.keyless ? true : !!(key || (id === "ollama" && stored.baseUrl));
    out.providers[id] = {
      type: id,
      label: adapter.label,
      keyless: adapter.keyless,
      internetRequired: adapter.internet,
      configured: configured,
      hasKey: !!key,
      keySource: key ? stored.apiKeySource || "file" : null,
      model: model,
      baseUrl: stored.baseUrl || (id === "ollama" ? "http://127.0.0.1:11434" : id === "pollinations" ? "https://text.pollinations.ai/openai" : ""),
      // Safe guidance only — never any part of a credential.
      keyHint:
        id === "gemini"
          ? "Free key: https://aistudio.google.com/apikey → 'Get API key'. Strings start with 'AIza'."
          : id === "ollama"
          ? "No key needed. Install from ollama.com and run 'ollama serve'."
          : id === "pollinations"
          ? "No key or account needed — community free endpoint. Internet required."
          : "Use the key your provider issued (check its pricing/free-tier terms)."
    };
  }
  if (cfg.activeProvider && out.providers[cfg.activeProvider]) {
    out.active = { id: cfg.activeProvider, model: cfg.activeModel || out.providers[cfg.activeProvider].model };
  }
  return out;
}

function maskKeyHint(cfg, providerId) {
  const stored = (cfg.providers && cfg.providers[providerId]) || {};
  const key = String(stored.apiKey || "");
  if (!key) return "no key stored";
  return "key stored (" + key.length + " chars, ends …" + key.slice(-4) + ")";
}

/* ------------------------------------------------------------------ */
/* API routes                                                          */
/* ------------------------------------------------------------------ */

const routes = {};

routes["GET /api/health"] = (req, res) => {
  staticFiles.sendJson(res, 200, {
    status: "ok",
    product: "Nexora AI",
    version: VERSION,
    stage: STAGE,
    stageName: "Roblox Developer Intelligence",
    publicDeployment: PUBLIC_MODE,
    managedPort: MANAGED_PORT,
    uptimeMs: Date.now() - startedAt,
    time: new Date().toISOString()
  });
};

routes["GET /api/providers"] = (req, res) => {
  staticFiles.sendJson(res, 200, publicProviderView(currentConfig()));
};

// Backward-compatible alias used by Stage 1 code paths.
routes["GET /api/models"] = routes["GET /api/providers"];

routes["POST /api/providers"] = async (req, res) => {
  if (PUBLIC_MODE && !ALLOW_CONFIG_WRITE) {
    staticFiles.sendJson(res, 403, {
      error: {
        message: "This deployment is read-only: provider settings are configured by the environment.",
        hint: "Set NEXORA_PROVIDER / NEXORA_MODEL and NEXORA_GEMINI_KEY (etc.) in the hosting dashboard.",
        code: "READ_ONLY_DEPLOYMENT", retryable: false
      }
    });
    return;
  }
  const body = await readJsonBody(req);
  const providerId = String(body.provider || "");
  if (!ai.PROVIDERS[providerId]) {
    staticFiles.sendJson(res, 400, { error: { message: "Unknown provider '" + providerId + "'.", hint: "Pick one of: " + Object.keys(ai.PROVIDERS).join(", ") } });
    return;
  }
  const adapter = ai.PROVIDERS[providerId];
  const cfg = currentConfig();
  cfg.providers = cfg.providers || {};
  const stored = Object.assign({}, cfg.providers[providerId] || { type: providerId });

  // An environment-provided credential wins over anything typed here.
  if (stored.apiKeySource === "env" && typeof body.apiKey === "string" && body.apiKey.trim() !== "") {
    staticFiles.sendJson(res, 409, {
      error: {
        message: adapter.label + "'s key is supplied by the deployment environment and cannot be changed here.",
        hint: "Update NEXORA_" + providerId.toUpperCase() + "_KEY in your hosting dashboard, then restart the service.",
        code: "KEY_FROM_ENV", retryable: false
      }
    });
    return;
  }

  // API key: write-only. Empty string keeps the existing key; "CLEAR" removes it.
  if (typeof body.apiKey === "string") {
    const trimmed = body.apiKey.trim();
    if (trimmed === "CLEAR") delete stored.apiKey;
    else if (trimmed !== "") stored.apiKey = trimmed;
  }
  if (typeof body.model === "string" && body.model.trim()) stored.model = body.model.trim();
  if (typeof body.baseUrl === "string") {
    const url = body.baseUrl.trim();
    if (!/^https?:\/\//i.test(url) && !adapter.keyless) {
      staticFiles.sendJson(res, 400, { error: { message: "Base URL must start with http:// or https://", hint: "Example: http://127.0.0.1:11434" } });
      return;
    }
    if (url) stored.baseUrl = url;
  }
  stored.type = providerId;
  cfg.providers[providerId] = stored;

  if (body.activate === true || !cfg.activeProvider) {
    cfg.activeProvider = providerId;
    cfg.activeModel = stored.model || adapter.defaultModel || "";
  }
  saveConfig(cfg);

  // Respond with the public view only — the key itself is never echoed back.
  const view = publicProviderView(cfg);
  staticFiles.sendJson(res, 200, { ok: true, key: maskKeyHint(cfg, providerId), view: view });
};

routes["POST /api/providers/test"] = async (req, res) => {
  const body = await readJsonBody(req);
  const providerId = String(body.provider || "");
  const adapter = ai.PROVIDERS[providerId];
  if (!adapter) {
    staticFiles.sendJson(res, 400, { error: { message: "Unknown provider '" + providerId + "'." } });
    return;
  }
  const cfg = currentConfig();
  const stored = (cfg.providers && cfg.providers[providerId]) || {};
  try {
    const models = await adapter.listModels(stored);
    staticFiles.sendJson(res, 200, {
      ok: true,
      provider: providerId,
      modelCount: models.length,
      models: models.slice(0, 60),
      note: models.length > 60 ? "showing first 60 of " + models.length : null
    });
  } catch (err) {
    const payload = err instanceof ai.AiError
      ? { message: err.message, hint: err.hint, code: err.code, retryable: err.retryable }
      : { message: "Connection test failed: " + (err.message || err), hint: "Check the provider settings.", retryable: true };
    staticFiles.sendJson(res, 502, { ok: false, provider: providerId, error: payload });
  }
};

/* ------------------------------------------------------------------ */
/* Live Studio status (real probe — cached briefly for chat turns)     */
/* ------------------------------------------------------------------ */
const STUDIO_CACHE_MS = 8000;
let studioCache = { at: 0, value: null };

async function studioStatus(force) {
  const now = Date.now();
  if (!force && studioCache.value && now - studioCache.at < STUDIO_CACHE_MS) return studioCache.value;
  const value = await studio.probeStatus(currentConfig().studio || {});
  studioCache = { at: Date.now(), value: value };
  return value;
}

routes["GET /api/studio/status"] = async (req, res) => {
  const force = /(\?|&)refresh=1/.test(req.url || "");
  const status = await studioStatus(force);
  staticFiles.sendJson(res, 200, {
    connected: !!status.connected,
    kind: status.kind || null,
    url: status.url || null,
    detail: status.detail || "",
    toolCount: (status.tools || []).length,
    tools: (status.tools || []).map((t) => ({ name: t.name, description: String(t.description || "").slice(0, 200) })),
    mcpUrlConfigured: !!status.mcpUrl,
    bridgeUrl: status.bridgeUrl || null
  });
};

routes["GET /api/studio/mcp/tools"] = async (req, res) => {
  const status = await studioStatus(true);
  if (!status.connected) {
    staticFiles.sendJson(res, 409, {
      error: {
        message: "No Studio tool connection is available.",
        hint: status.detail || "Set studio.mcpUrl (or NEXORA_MCP_URL) to a running MCP server, or studio.bridgeUrl to a live bridge.",
        code: "STUDIO_DISCONNECTED", retryable: false
      }
    });
    return;
  }
  staticFiles.sendJson(res, 200, { connected: true, kind: status.kind, url: status.url, tools: status.tools || [] });
};

routes["POST /api/studio/mcp/call"] = async (req, res) => {
  // A public deployment must never let anonymous visitors execute tools on
  // whatever machine the Studio connector belongs to.
  if (PUBLIC_MODE && !tokenMatches(req.headers["x-nexora-studio-token"])) {
    staticFiles.sendJson(res, 403, {
      error: {
        message: "Studio tool calls are locked on this deployment.",
        hint: "Send the X-Nexora-Studio-Token header matching NEXORA_STUDIO_TOKEN.",
        code: "STUDIO_LOCKED", retryable: false
      }
    });
    return;
  }
  const body = await readJsonBody(req);
  const status = await studioStatus(true);
  if (!status.connected) {
    staticFiles.sendJson(res, 409, { error: { message: "No Studio tool connection is available.", hint: status.detail || "", code: "STUDIO_DISCONNECTED", retryable: false } });
    return;
  }
  const toolName = String(body.tool || "");
  if (!toolName) {
    staticFiles.sendJson(res, 400, { error: { message: "Missing 'tool' name." } });
    return;
  }
  const known = (status.tools || []).find((t) => t.name === toolName);
  if (!known) {
    staticFiles.sendJson(res, 400, { error: { message: "Tool '" + toolName + "' is not offered by the connected server.", hint: "Available: " + (status.tools || []).map((t) => t.name).join(", ") } });
    return;
  }
  try {
    const result = await studio.mcpCallTool(status.url, status.sessionId, toolName, body.args || {}, 15000);
    const texts = ((result && result.content) || []).map((c) => (c && c.text) || "").filter(Boolean);
    staticFiles.sendJson(res, 200, { ok: true, tool: toolName, output: texts.join("\n").slice(0, 20000) });
  } catch (err) {
    staticFiles.sendJson(res, 502, { error: { message: "Tool call failed: " + String(err.message || err).slice(0, 400), retryable: true } });
  }
};

/* ------------------------------------------------------------------ */
/* Chat: system prompt → provider → Studio directives → verification   */
/* ------------------------------------------------------------------ */

const TOOL_ROUNDS_MAX = 3;
const REPAIR_ROUNDS_MAX = 2;
const PROVIDER_WAIT_MS = 32_000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Call the provider once, waiting out a free-tier per-IP pacing limit once. */
async function chatWithPacing(adapter, stored, messages, system, model) {
  try {
    return await adapter.chat(stored, { messages, system, model });
  } catch (err) {
    const rateHit =
      err instanceof ai.AiError &&
      (err.code === "RATE_LIMIT" || /402|free limit|rate limit|1 reply every/i.test([err.code, err.message, err.hint].join(" ")));
    if (rateHit) {
      await sleep(PROVIDER_WAIT_MS);
      return adapter.chat(stored, { messages, system, model });
    }
    throw err;
  }
}

routes["POST /api/chat"] = async (req, res) => {
  const ip = clientIp(req);
  if (chatRateLimited(ip)) {
    staticFiles.sendJson(res, 429, { error: { message: "Too many chat requests. Wait a minute and try again.", retryable: true } });
    return;
  }

  const body = await readJsonBody(req);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    staticFiles.sendJson(res, 400, { error: { message: "Message is empty.", hint: "Type something and press Send." } });
    return;
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    staticFiles.sendJson(res, 400, { error: { message: "Message is too long (" + message.length + " chars).", hint: "Keep messages under " + MAX_MESSAGE_CHARS + " characters." } });
    return;
  }

  const cfg = currentConfig();
  const providerId = cfg.activeProvider;
  if (!providerId || !ai.PROVIDERS[providerId]) {
    staticFiles.sendJson(res, 400, {
      error: {
        message: "No AI provider is active.",
        hint: "Open Models, configure a provider (Pollinations needs no key), and press 'Save & Activate'.",
        code: "NOT_CONFIGURED", retryable: false
      }
    });
    return;
  }
  const adapter = ai.PROVIDERS[providerId];
  const stored = (cfg.providers && cfg.providers[providerId]) || {};
  const model = (typeof body.model === "string" && body.model.trim()) || cfg.activeModel || adapter.defaultModel || "";
  if (!model) {
    staticFiles.sendJson(res, 400, {
      error: { message: "No model selected for " + adapter.label + ".", hint: "Pick a model in Models → " + adapter.label + ".", code: "NO_MODEL", retryable: false }
    });
    return;
  }

  const history = ai.trimMessages(Array.isArray(body.history) ? body.history : []).slice(-MAX_HISTORY_MESSAGES);
  const persona = cfg.persona || {};
  const st = await studioStatus(false);
  const system = promptLib.buildSystemPrompt({
    persona: persona,
    studio: st && st.connected ? { connected: true, kind: st.kind, url: st.url, tools: st.tools || [] } : null
  });

  const t0 = Date.now();
  const messages = history.concat([{ role: "user", content: message }]);
  let toolRounds = 0;
  let repairRounds = 0;
  let truncated = false;
  try {
    let result = await chatWithPacing(adapter, stored, messages, system, model);
    let text = result.text;
    truncated = !!result.truncated;

    /* --- Stage 2.5 loop A: real Studio inspections (only when connected) --- */
    let directives = studio.parseDirectives(text);
    while (directives.length && st.connected && toolRounds < TOOL_ROUNDS_MAX) {
      const outputs = [];
      for (const d of directives.slice(0, 3)) {
        outputs.push(await studio.runDirective(studio, d));
        toolRounds += 1;
      }
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: outputs.join("\n\n") });
      result = await chatWithPacing(adapter, stored, messages, system, model);
      text = result.text;
      truncated = !!result.truncated;
      directives = studio.parseDirectives(text);
    }
    // Directives while disconnected: one honest correction round, never a fake inspection.
    if (directives.length && !st.connected && repairRounds < 1) {
      messages.push({ role: "assistant", content: text });
      messages.push({
        role: "user",
        content:
          "[System note] Studio is NOT connected, so no inspection is possible. " +
          "You must not claim to have inspected anything and must not emit inspection directives again. " +
          "Answer the original request honestly: state the assumption or ask ONE clarifying question."
      });
      const corrected = await adapter.chat(stored, { messages, system, model });
      text = studio.stripDirectives(corrected.text) || text;
      repairRounds += 1;
    }
    text = studio.stripDirectives(text);

    /* --- Stage 2.5 loop B: mandatory answer verification + correction --- */
    let verification = verifier.verifyAnswer(text, { request: message });
    const repairNeeded = verification.stats.errors > 0 || verification.stats.warnings >= 2;
    while (repairNeeded && (verification.stats.errors > 0 || verification.stats.warnings >= 2) && repairRounds < REPAIR_ROUNDS_MAX) {
      const instruction =
        "Your previous answer failed Nexora's automated Roblox verification. Fix every item below and " +
        "return the COMPLETE corrected answer (same structure, all code included). Do not mention this review to the user.\n\n" +
        verifier.findingsPrompt(verification.findings);
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: instruction });
      const repaired = await chatWithPacing(adapter, stored, messages, system, model);
      const candidate = studio.stripDirectives(repaired.text);
      const recheck = verifier.verifyAnswer(candidate, { request: message });
      repairRounds += 1;
      const candidateScore = recheck.stats.errors * 10 + recheck.stats.warnings;
      const currentScore = verification.stats.errors * 10 + verification.stats.warnings;
      // Prefer a complete (non-truncated) repair when the scores tie.
      const candidateBetter = candidateScore < currentScore ||
        (candidateScore === currentScore && truncated && !repaired.truncated);
      if (candidateBetter) {
        text = candidate;
        verification = recheck;
        truncated = !!repaired.truncated;
      }
      if (candidateScore === 0) break;
    }

    // Log metadata only — no message content, no keys.
    console.log(
      "[nexora] chat ok provider=" + providerId + " model=" + result.model +
      " ms=" + (Date.now() - t0) + " chars=" + text.length +
      " verify=e" + verification.stats.errors + ":w" + verification.stats.warnings +
      " repair=" + repairRounds + " tools=" + toolRounds
    );
    staticFiles.sendJson(res, 200, {
      text: text,
      provider: providerId,
      providerLabel: adapter.label,
      model: result.model,
      usage: result.usage || null,
      ms: Date.now() - t0,
      truncated: truncated,
      verification: {
        checked: true,
        findings: verification.findings.map((f) => ({ level: f.level, code: f.code, message: f.message })),
        remaining: verification.findings.length,
        repairRounds: repairRounds,
        studioRounds: toolRounds
      }
    });
  } catch (err) {
    const payload = err instanceof ai.AiError
      ? { message: err.message, hint: err.hint, code: err.code, retryable: err.retryable }
      : { message: "Unexpected AI error: " + (err && err.message || err), hint: "Try again. If it persists, check Models.", retryable: true };
    console.warn("[nexora] chat fail provider=" + providerId + " model=" + model + " code=" + payload.code + " ms=" + (Date.now() - t0));
    staticFiles.sendJson(res, 502, { error: payload, provider: providerId, model: model });
  }
};

function handleApi(req, res, pathname) {
  const key = req.method + " " + pathname;
  const handler = routes[key];
  if (!handler) {
    if (pathname.startsWith("/api/") && req.method !== "GET") {
      staticFiles.sendJson(res, 405, { error: "Method not allowed.", allow: "GET" });
      return;
    }
    staticFiles.sendJson(res, 404, { error: "Unknown API endpoint." });
    return;
  }
  const ip = clientIp(req);
  // Chat requests are handled by the dedicated chat limiter inside the
  // handler (different burst budget); do not double-count them here.
  if (pathname !== "/api/chat" && apiRateLimited(ip)) {
    staticFiles.sendJson(res, 429, { error: "Too many requests. Try again in a minute." });
    return;
  }
  Promise.resolve()
    .then(() => handler(req, res))
    .catch((err) => {
      const status = err && err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      const message = err instanceof ai.AiError ? err.message : "Internal server error.";
      const hint = err instanceof ai.AiError ? err.hint : null;
      if (status >= 500) console.error("[nexora] API error on " + key + ":", err && err.message);
      if (!res.headersSent) staticFiles.sendJson(res, status, { error: { message: message, hint: hint } });
    });
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  let pathname = "/";
  try {
    pathname = new URL(req.url || "/", "http://" + (req.headers.host || "localhost")).pathname;
  } catch (_e) {
    staticFiles.sendJson(res, 400, { error: "Malformed request URL." });
    return;
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    handleApi(req, res, pathname);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    staticFiles.sendJson(res, 405, { error: "Method not allowed." });
    return;
  }
  staticFiles.serve(req, res, pathname);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      "[nexora] Port " + PORT + " is already in use.\n" +
      "         Free the port, or start Nexora on another one:\n" +
      "         set NEXORA_PORT=7811  (PowerShell: $env:NEXORA_PORT='7811')"
    );
  } else {
    console.error("[nexora] Server error:", err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  if (typeof server.keepAliveTimeout === "number") server.keepAliveTimeout = 65_000;
  const cfg = currentConfig();
  const active = cfg.activeProvider || "(none)";
  console.log("");
  console.log("  ▲ NEXORA AI  ·  server ready");
  console.log("    URL      http://" + HOST + ":" + PORT);
  console.log("    Version  " + VERSION + "  ·  Stage " + STAGE + " (Roblox Developer Intelligence)");
  console.log("    Mode     " + (PUBLIC_MODE ? "PUBLIC (read-only config, HSTS, Studio calls locked)" : "local") +
    (MANAGED_PORT ? " · platform port" : "") + (TRUST_PROXY ? " · proxy-aware IP" : ""));
  console.log("    Active   " + active + (cfg.activeModel ? " · " + cfg.activeModel : ""));
  const envKeys = config.envManagedProviders();
  if (envKeys.length) console.log("    Keys     " + envKeys.join(", ") + " (from environment — never written to disk)");
  console.log("    Studio   bridge " + ((cfg.studio && cfg.studio.bridgeUrl) || "-") +
    " · MCP " + ((cfg.studio && cfg.studio.mcpUrl) || "not configured") + " (probing on request)");
  console.log("");
  console.log("  Press Ctrl+C to stop.");
});
