"use strict";
/**
 * Nexora AI — configuration store (server-side only).
 * Lives outside public/, so its contents are never sent to the browser.
 * Stage 2 will store provider credentials here or in environment variables.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// NEXORA_CONFIG_DIR lets tests run against an isolated config directory.
const CONFIG_DIR = process.env.NEXORA_CONFIG_DIR
  ? path.resolve(process.env.NEXORA_CONFIG_DIR)
  : path.join(ROOT, "config");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_PATH = path.join(CONFIG_DIR, "settings.json");

const DEFAULTS = {
  _readme:
    "Nexora AI local configuration. Provider credentials belong here (or in environment variables). " +
    "This file is never served to the browser. Do not commit it to a public repository.",
  app: { name: "Nexora AI", version: "0.3.0", stage: 2 },
  ui: { theme: "dark-violet" },
  persona: {
    // Project-level instructions appended after Nexora's core Roblox prompt.
    systemPrompt:
      "Be practical and concrete: give working code when asked for code, explain plainly, " +
      "and never invent Roblox APIs that do not exist. When suggesting project changes, " +
      "describe them clearly — the user approves every change before anything is applied."
  },
  // Provider configuration. apiKey values are write-only: the API never returns them.
  providers: {
    // Keyless free community endpoint — enabled by default so chat works with zero setup.
    pollinations: { type: "pollinations", model: "openai-fast", baseUrl: "https://text.pollinations.ai/openai" }
  },
  activeProvider: "pollinations",
  activeModel: "openai-fast",
  studio: {
    // Stage 4: Nexora probes this local endpoint and only reports Connected on a real response.
    bridgeUrl: "http://127.0.0.1:3587",
    // Optional: a real MCP server (e.g. a Roblox Studio MCP). Also settable via
    // env NEXORA_MCP_URL. Left empty → Studio status is honestly Disconnected.
    mcpUrl: ""
  }
};

/**
 * Deployment environment overrides.
 *
 * A hosted instance usually has an EPHEMERAL disk, so keys written to
 * config/settings.json would vanish on every restart. Credentials therefore
 * come from environment variables set in the hosting dashboard. Env-managed
 * keys are marked so they are never written back to disk (see save()).
 */
const ENV_KEY_VARS = {
  gemini: ["NEXORA_GEMINI_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["NEXORA_OPENAI_KEY", "OPENAI_API_KEY"],
  pollinations: ["NEXORA_POLLINATIONS_KEY", "POLLINATIONS_API_KEY"]
};

// Optional base-URL overrides, so an OpenAI-compatible host (GitHub Models,
// OpenRouter, vLLM, ...) can be selected without a settings.json file.
const ENV_BASE_VARS = {
  openai: ["NEXORA_OPENAI_BASE_URL", "OPENAI_BASE_URL"],
  ollama: ["NEXORA_OLLAMA_URL", "OLLAMA_HOST"],
  pollinations: ["NEXORA_POLLINATIONS_BASE_URL"]
};

let envKeyReport = {};

function firstEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return "";
}

function applyEnvOverrides(cfg) {
  cfg.providers = cfg.providers || {};
  envKeyReport = {};
  for (const [id, names] of Object.entries(ENV_KEY_VARS)) {
    const key = firstEnv(names);
    if (!key) continue;
    const stored = Object.assign({ type: id }, cfg.providers[id] || {});
    stored.apiKey = key;
    stored.apiKeySource = "env";
    cfg.providers[id] = stored;
    envKeyReport[id] = true;
  }
  for (const [id, names] of Object.entries(ENV_BASE_VARS)) {
    const baseUrl = firstEnv(names);
    if (!baseUrl) continue;
    const stored = Object.assign({ type: id }, cfg.providers[id] || {});
    stored.baseUrl = baseUrl;
    cfg.providers[id] = stored;
  }
  const providerEnv = String(process.env.NEXORA_PROVIDER || "").trim();
  if (providerEnv) {
    // A hosted instance has no settings.json, so the selected provider may not
    // exist yet. Create the entry from env instead of silently falling back.
    if (!cfg.providers[providerEnv]) cfg.providers[providerEnv] = { type: providerEnv };
    cfg.activeProvider = providerEnv;
    cfg.activeModel = cfg.providers[providerEnv].model || "";
  }
  const modelEnv = String(process.env.NEXORA_MODEL || "").trim();
  if (modelEnv) cfg.activeModel = modelEnv;
  return cfg;
}

/** Provider ids whose credential comes from the environment (never from disk). */
function envManagedProviders() {
  return Object.keys(envKeyReport);
}

function ensureDirs() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** mtime of settings.json in ms, or -1 when the file does not exist. */
function statMtimeMs() {
  try {
    return fs.statSync(CONFIG_PATH).mtimeMs;
  } catch (_e) {
    return -1;
  }
}

function load() {
  ensureDirs();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + "\n", "utf8");
    return applyEnvOverrides(deepMerge(structuredClone(DEFAULTS), {}));
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return applyEnvOverrides(deepMerge(structuredClone(DEFAULTS), parsed));
  } catch (err) {
    console.warn("[nexora] config/settings.json could not be read (" + err.message + "); using defaults.");
    return applyEnvOverrides(deepMerge(structuredClone(DEFAULTS), {}));
  }
}

/** Write config to disk, stripping anything supplied by the environment. */
function save(config) {
  ensureDirs();
  const disk = structuredClone(config);
  for (const stored of Object.values(disk.providers || {})) {
    if (stored && stored.apiKeySource === "env") {
      delete stored.apiKey;
      delete stored.apiKeySource;
    }
  }
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(disk, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
  return config;
}

function deepMerge(base, extra) {
  for (const key of Object.keys(extra)) {
    const v = extra[key];
    if (v === null || v === undefined) continue; // null in a config file means "unset" — keep the default
    if (typeof v === "object" && !Array.isArray(v) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      deepMerge(base[key], v);
    } else {
      base[key] = v;
    }
  }
  return base;
}

module.exports = { ROOT, CONFIG_DIR, DATA_DIR, CONFIG_PATH, DEFAULTS, load, save, ensureDirs, statMtimeMs, envManagedProviders };
