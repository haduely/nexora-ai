"use strict";
/**
 * Nexora AI — provider adapters.
 *
 * One unified interface over four real providers:
 *   gemini        Google Gemini API (free tier with a key from aistudio.google.com)
 *   ollama        Local Ollama runtime (no key, no internet)
 *   openai        Any OpenAI-compatible base URL (key depends on provider)
 *   pollinations  Keyless free community endpoint (no account needed)
 *
 * Every adapter returns { text, model, usage? } or throws AiError with a
 * beginner-friendly message, a fix hint, and a retryable flag.
 * API keys never leave this process.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const POLLINATIONS_BASE = "https://text.pollinations.ai/openai";

const DEFAULT_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 25_000;

class AiError extends Error {
  constructor(message, opts) {
    super(message);
    this.name = "AiError";
    this.status = (opts && opts.status) || 500;
    this.code = (opts && opts.code) || "AI_ERROR";
    this.hint = (opts && opts.hint) || null;
    this.retryable = !!(opts && opts.retryable);
  }
  toJSON() {
    return { message: this.message, code: this.code, hint: this.hint, retryable: this.retryable, status: this.status };
  }
}

/* ----------------------------- utilities ----------------------------- */

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_e) { body = null; }
    return { res, text, body };
  } catch (err) {
    if (err.name === "AbortError") {
      throw new AiError("The AI request timed out after " + Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000) + "s.", {
        status: 504, code: "TIMEOUT", retryable: true,
        hint: "The model may be overloaded or your connection slow. Try again, or pick a faster model."
      });
    }
    const msg = String(err.message || err);
    throw new AiError("Could not reach the AI provider: " + msg, {
      status: 502, code: "NETWORK", retryable: true,
      hint: /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(msg)
        ? "Check your internet connection, or if you meant a local provider, make sure it is running (for Ollama: install it from ollama.com and run 'ollama serve')."
        : "Check your network connection and try again."
    });
  } finally {
    clearTimeout(timer);
  }
}

function trimMessages(messages) {
  return (messages || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
}

function firstText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
}

/* ------------------------------- Gemini ------------------------------ */

function geminiHeaders(key) {
  return { "Content-Type": "application/json", "x-goog-api-key": key };
}

function geminiError(status, body, fallbackText) {
  const err = body && body.error;
  const reason = (err && Array.isArray(err.details) && err.details.find((d) => d.reason) && err.details.find((d) => d.reason).reason) || "";
  const apiMessage = (err && err.message) || fallbackText || "";

  if (status === 400 && (reason === "API_KEY_INVALID" || /API key not valid/i.test(apiMessage))) {
    return new AiError("Google rejected the API key as invalid.", {
      status, code: "GEMINI_API_KEY_INVALID", retryable: false,
      hint: "Get a free key at https://aistudio.google.com/apikey (sign in with a Google account), copy the string starting with 'AIza', and paste it in Models → Gemini."
    });
  }
  if (status === 403) {
    return new AiError("Google denied access (403): " + apiMessage, {
      status, code: "GEMINI_FORBIDDEN", retryable: false,
      hint: "The key may lack permission for this API, or the Generative Language API may not be enabled for its project. Create a fresh key at aistudio.google.com/apikey."
    });
  }
  if (status === 404 || /NOT_FOUND|was not found/i.test(apiMessage)) {
    return new AiError("Gemini model not found: " + apiMessage, {
      status, code: "GEMINI_MODEL_NOT_FOUND", retryable: false,
      hint: "In Models → Gemini, press 'Load models' to list the models your key can use, or set the model to 'gemini-flash-latest'."
    });
  }
  if (status === 429 || reason === "RESOURCE_EXHAUSTED") {
    return new AiError("Gemini rate limit or free-tier quota exceeded.", {
      status, code: "GEMINI_QUOTA", retryable: true,
      hint: "Free-tier keys have per-minute and per-day limits. Wait a minute and retry, or reduce message size. Live limits are shown at https://ai.google.dev/gemini-api/docs/rate-limits"
    });
  }
  if (status === 503 || /OVERLOADED|overloaded/i.test(apiMessage)) {
    return new AiError("Gemini is overloaded right now (503).", {
      status, code: "GEMINI_OVERLOADED", retryable: true,
      hint: "Google reports temporary overload. Wait a few seconds and retry."
    });
  }
  return new AiError("Gemini error " + status + ": " + (apiMessage || "unknown error"), {
    status, code: "GEMINI_ERROR", retryable: status >= 500,
    hint: status >= 500 ? "This looks like a temporary Google-side problem — retry shortly." : "Check the model name and key in Models → Gemini."
  });
}

async function geminiChat(cfg, { messages, system, model, timeoutMs }) {
  const key = String(cfg.apiKey || "").trim();
  if (!key) {
    throw new AiError("No Gemini API key is configured.", {
      status: 400, code: "NOT_CONFIGURED", retryable: false,
      hint: "Get a free key at https://aistudio.google.com/apikey and save it in Models → Gemini."
    });
  }
  const usesSystem = !!system;
  const contents = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text: m.content });
    else contents.push({ role, parts: [{ text: m.content }] });
  }
  const body = { contents };
  if (usesSystem) body.systemInstruction = { parts: [{ text: system }] };

  const url = GEMINI_BASE + "/models/" + encodeURIComponent(model) + ":generateContent";
  const { res, body: data, text } = await fetchJson(
    url,
    { method: "POST", headers: geminiHeaders(key), body: JSON.stringify(body) },
    timeoutMs
  );

  if (!res.ok) throw geminiError(res.status, data, text);

  const cand = data && Array.isArray(data.candidates) && data.candidates[0];
  if (!cand) {
    const block = data && data.promptFeedback && data.promptFeedback.blockReason;
    throw new AiError(block ? "Gemini blocked the prompt (" + block + ")." : "Gemini returned an empty response.", {
      status: 502, code: "GEMINI_EMPTY", retryable: !block,
      hint: block
        ? "The request was stopped by Google's safety filters. Rephrase the message."
        : "Retry; if it keeps happening, try a different model."
    });
  }
  const out = firstText(cand.content && cand.content.parts);
  if (!out.trim()) {
    throw new AiError("Gemini returned an empty response (" + (cand.finishReason || "no finish reason") + ").", {
      status: 502, code: "GEMINI_EMPTY", retryable: true,
      hint: cand.finishReason === "SAFETY" ? "Google's safety system stopped the response. Rephrase your message." : "Retry, or try another model."
    });
  }
  return { text: out, model: model, usage: data.usageMetadata || null };
}

async function geminiListModels(cfg) {
  const key = String(cfg.apiKey || "").trim();
  if (!key) {
    throw new AiError("No Gemini API key is configured.", {
      status: 400, code: "NOT_CONFIGURED", retryable: false,
      hint: "Save a key in Models → Gemini first (free at aistudio.google.com/apikey)."
    });
  }
  const { res, body, text } = await fetchJson(
    GEMINI_BASE + "/models?pageSize=200",
    { method: "GET", headers: geminiHeaders(key) },
    TEST_TIMEOUT_MS
  );
  return geminiModelsFrom(res.status, body, text);
}

function geminiModelsFrom(status, body, text) {
  if (status !== 200) throw geminiError(status, body, text);
  const models = (body && Array.isArray(body.models) ? body.models : [])
    .filter((m) => typeof m.name === "string" && /gemini-(2|3)/i.test(m.name))
    .filter((m) => !/embedding|aqa|imagen|veo|tts/i.test(m.name))
    .map((m) => m.name.replace(/^models\//, ""))
    .sort();
  if (models.length === 0) {
    throw new AiError("No Gemini models are available for this key.", {
      status: 502, code: "GEMINI_NO_MODELS", retryable: false,
      hint: "Verify the key at aistudio.google.com/apikey."
    });
  }
  return models;
}

/* ------------------------------- Ollama ------------------------------ */

function ollamaBase(cfg) {
  return String(cfg.baseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

function ollamaError(err, status, apiMessage) {
  if (err instanceof AiError) return err;
  if (status === 404 || /not found|model.*not/i.test(apiMessage || "")) {
    return new AiError("Ollama does not have that model installed.", {
      status: 404, code: "OLLAMA_MODEL_MISSING", retryable: false,
      hint: "Install it first, e.g.:  ollama pull qwen2.5-coder:7b   — then press 'Load models' in Models → Ollama and pick it."
    });
  }
  return new AiError("Ollama error " + (status || "?") + ": " + (apiMessage || err.message || "unknown"), {
    status: status || 500, code: "OLLAMA_ERROR", retryable: !status || status >= 500,
    hint: "Check that 'ollama serve' is running and the model is pulled."
  });
}

async function ollamaChat(cfg, { messages, system, model, timeoutMs }) {
  const base = ollamaBase(cfg);
  const payload = { model: model, stream: false, messages: [] };
  if (system) payload.messages.push({ role: "system", content: system });
  for (const m of messages) payload.messages.push({ role: m.role, content: m.content });

  let res, data, text;
  try {
    ({ res, body: data, text } = await fetchJson(
      base + "/api/chat",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      timeoutMs
    ));
  } catch (err) {
    if (err.code === "NETWORK" && /ECONNREFUSED/i.test(err.message + (err.hint || ""))) {
      throw new AiError("Ollama is not running at " + base + ".", {
        status: 503, code: "OLLAMA_DOWN", retryable: false,
        hint: "Install Ollama from https://ollama.com, then start it (run 'ollama serve', or launch the Ollama app). Press Test again once it is up."
      });
    }
    throw err;
  }
  if (!res.ok) throw ollamaError(null, res.status, (data && data.error) || text);

  const out = data && data.message && data.message.content;
  if (!out || !String(out).trim()) {
    throw new AiError("Ollama returned an empty response.", {
      status: 502, code: "OLLAMA_EMPTY", retryable: true,
      hint: "Try again, or pick a different installed model."
    });
  }
  return { text: String(out), model: model, usage: data && data.prompt_eval_count ? { promptTokens: data.prompt_eval_count, candidatesTokens: data.eval_count } : null };
}

async function ollamaListModels(cfg) {
  const base = ollamaBase(cfg);
  let res, data, text;
  try {
    ({ res, body: data, text } = await fetchJson(base + "/api/tags", { method: "GET" }, TEST_TIMEOUT_MS));
  } catch (err) {
    if (err.code === "NETWORK") {
      throw new AiError("Ollama is not running at " + base + ".", {
        status: 503, code: "OLLAMA_DOWN", retryable: false,
        hint: "Install Ollama from https://ollama.com and start it ('ollama serve'), then press Test again."
      });
    }
    throw err;
  }
  if (!res.ok) throw ollamaError(null, res.status, text);
  const models = (data && Array.isArray(data.models) ? data.models : []).map((m) => m.name).filter(Boolean);
  if (models.length === 0) {
    throw new AiError("Ollama is running but has no models installed.", {
      status: 404, code: "OLLAMA_NO_MODELS", retryable: false,
      hint: "Install one, e.g.:  ollama pull qwen2.5-coder:7b   (or any chat model you prefer)."
    });
  }
  return models.sort();
}

/* --------------------- OpenAI-compatible + Pollinations ---------------- */

function openaiBase(cfg, keyless) {
  if (keyless) return POLLINATIONS_BASE;
  return String(cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function openaiError(status, body, apiMessage, label) {
  if (status === 401 || status === 403) {
    return new AiError(label + " rejected the API key (" + status + ").", {
      status, code: "AUTH", retryable: false,
      hint: "Double-check the key (no extra spaces), make sure the account/credit is active, and confirm the base URL matches the provider."
    });
  }
  if (status === 404) {
    return new AiError(label + ": model or endpoint not found (404).", {
      status, code: "MODEL_NOT_FOUND", retryable: false,
      hint: "Check the model name ('Load models' lists what is available) and the base URL (it usually ends in /v1)."
    });
  }
  if (status === 429) {
    return new AiError(label + " rate limit or quota exceeded (429).", {
      status, code: "RATE_LIMIT", retryable: true,
      hint: "You hit the provider's speed or usage limit. Wait and retry. Free tiers reset after a minute or a day depending on the provider."
    });
  }
  if (status === 402 || /free limit|1 reply every/i.test(apiMessage || "")) {
    return new AiError(label + " free-tier pacing limit hit: " + (apiMessage || "one reply every 30 seconds per IP."), {
      status, code: "RATE_LIMIT", retryable: true,
      hint: "The keyless free tier allows one reply roughly every 30 seconds per IP. Wait ~30 seconds and press Retry, or use Gemini (free key) for higher limits."
    });
  }
  if (status >= 500) {
    return new AiError(label + " server error (" + status + ").", {
      status, code: "UPSTREAM", retryable: true,
      hint: "The provider is having trouble. Retry in a few seconds."
    });
  }
  return new AiError(label + " error " + status + ": " + (apiMessage || "unknown"), {
    status, code: "PROVIDER_ERROR", retryable: false,
    hint: "Check the provider settings in Models."
  });
}

async function openaiChat(cfg, { messages, system, model, timeoutMs }, label, keyless) {
  const base = openaiBase(cfg, keyless);
  const payload = { model: model, stream: false, messages: [] };
  if (system) payload.messages.push({ role: "system", content: system });
  for (const m of messages) payload.messages.push({ role: m.role, content: m.content });

  // The keyless Pollinations endpoint serves a reasoning model. Without a low
  // reasoning budget its hidden reasoning can consume the whole reply budget
  // and come back with `content: null` (an "empty" answer). Keep the visible
  // answer's budget explicit so real code always fits.
  if (keyless) {
    payload.reasoning_effort = "low";
    payload.max_tokens = 4096;
  }

  const headers = { "Content-Type": "application/json" };
  if (!keyless) {
    const key = String(cfg.apiKey || "").trim();
    if (!key) {
      throw new AiError("No API key is configured for " + label + ".", {
        status: 400, code: "NOT_CONFIGURED", retryable: false,
        hint: "Add the key in Models → " + label + ". Make sure it is a valid key from that provider."
      });
    }
    headers.Authorization = "Bearer " + key;
  }

  const { res, body: data, text } = await fetchJson(
    base + "/chat/completions",
    { method: "POST", headers: headers, body: JSON.stringify(payload) },
    timeoutMs
  );
  if (!res.ok) {
    const apiMessage = (data && data.error && (data.error.message || data.error)) || text;
    throw openaiError(res.status, data, typeof apiMessage === "string" ? apiMessage : "", label);
  }

  const choice = data && Array.isArray(data.choices) && data.choices[0];
  const msg = choice && choice.message;
  const out = (msg && (msg.content || msg.reasoning_content)) || "";
  if (!String(out).trim()) {
    throw new AiError(label + " returned an empty response.", {
      status: 502, code: "EMPTY", retryable: true,
      hint: "Retry, or choose a different model."
    });
  }
  return {
    text: String(out),
    model: (data && data.model) || model,
    usage: data && data.usage,
    truncated: !!(choice && choice.finish_reason === "length")
  };
}

async function openaiListModels(cfg, label, keyless) {
  const base = openaiBase(cfg, keyless);
  const headers = {};
  if (!keyless) {
    const key = String(cfg.apiKey || "").trim();
    if (!key) {
      throw new AiError("No API key is configured for " + label + ".", {
        status: 400, code: "NOT_CONFIGURED", retryable: false,
        hint: "Save the key in Models → " + label + " first."
      });
    }
    headers.Authorization = "Bearer " + key;
  }
  const { res, body, text } = await fetchJson(base + "/models", { method: "GET", headers: headers }, TEST_TIMEOUT_MS);
  if (!res.ok) throw openaiError(res.status, body, text, label);
  const models = (body && Array.isArray(body.data) ? body.data : [])
    .map((m) => m.id)
    .filter((id) => typeof id === "string");
  if (models.length === 0) {
    throw new AiError(label + " returned no models.", {
      status: 502, code: "NO_MODELS", retryable: false, hint: "Check the provider settings in Models."
    });
  }
  return models.sort();
}

/* ------------------------------ registry ----------------------------- */

const PROVIDERS = {
  pollinations: {
    label: "Pollinations (keyless)",
    keyless: true,
    internet: true,
    defaultModel: "openai-fast",
    chat: (cfg, opts) => openaiChat(cfg, opts, "Pollinations", true),
    listModels: (cfg) => openaiListModels(cfg, "Pollinations", true)
  },
  gemini: {
    label: "Google Gemini",
    keyless: false,
    internet: true,
    defaultModel: "gemini-flash-latest",
    chat: geminiChat,
    listModels: geminiListModels
  },
  ollama: {
    label: "Ollama (local)",
    keyless: false,
    internet: false,
    defaultModel: "",
    chat: ollamaChat,
    listModels: ollamaListModels
  },
  openai: {
    label: "OpenAI-compatible",
    keyless: false,
    internet: true,
    defaultModel: "",
    chat: (cfg, opts) => openaiChat(cfg, opts, "This provider", false),
    listModels: (cfg) => openaiListModels(cfg, "This provider", false)
  }
};

function getAdapter(providerId) {
  const adapter = PROVIDERS[providerId];
  if (!adapter) {
    throw new AiError("Unknown AI provider '" + providerId + "'.", {
      status: 400, code: "UNKNOWN_PROVIDER", retryable: false,
      hint: "Choose one of: " + Object.keys(PROVIDERS).join(", ") + "."
    });
  }
  return adapter;
}

module.exports = { AiError, PROVIDERS, getAdapter, trimMessages };
