"use strict";
/**
 * Nexora AI — server integration test.
 * Boots the real server on a test port with an ISOLATED config directory,
 * exercises the HTTP surface (including key-security and chat validation),
 * and shuts it down. Run with:
 *   node tests/server.test.js
 */
const assert = require("assert");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.NEXORA_TEST_PORT || 7899);
const ROOT = path.join(__dirname, "..");
const TMP_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-test-config-"));

function request(method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let bodyText = "";
    if (payload !== undefined) {
      bodyText = JSON.stringify(payload);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyText);
    }
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: urlPath, method: method, headers: headers, timeout: 8000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: body }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.end(bodyText);
  });
}

async function waitForServer(child, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (child.exitCode !== null) throw new Error("server exited early with code " + child.exitCode);
    try {
      const res = await request("GET", "/api/health");
      if (res.status === 200) return;
    } catch (_e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become ready on port " + PORT);
}

let passed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  ok  " + label);
  } catch (err) {
    console.error("  FAIL " + label + " — " + err.message);
    process.exitCode = 1;
    throw err;
  }
}

async function main() {
  console.log("Nexora AI — server integration tests (port " + PORT + ", isolated config)");

  const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NEXORA_PORT: String(PORT),
      NEXORA_HOST: "127.0.0.1",
      NEXORA_CONFIG_DIR: TMP_CONFIG
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverLog = "";
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));

  try {
    await waitForServer(child);

    await check("GET / serves the Nexora interface", async () => {
      const res = await request("GET", "/");
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers["content-type"].includes("text/html"));
      assert.ok(res.body.includes("NEXORA"), "branding missing");
      assert.ok(res.body.includes('data-view-panel="chat"'), "chat view missing");
      assert.ok(res.body.includes("providerGrid"), "provider grid missing");
    });

    await check("GET /api/health reports Stage 2", async () => {
      const res = await request("GET", "/api/health");
      assert.strictEqual(res.status, 200);
      const json = JSON.parse(res.body);
      assert.strictEqual(json.status, "ok");
      assert.strictEqual(json.product, "Nexora AI");
      assert.strictEqual(json.stage, 2);
    });

    await check("GET /api/providers reports honest provider state", async () => {
      const res = await request("GET", "/api/providers");
      assert.strictEqual(res.status, 200);
      const json = JSON.parse(res.body);
      assert.ok(json.providers.pollinations, "pollinations adapter missing");
      assert.strictEqual(json.providers.pollinations.configured, true);
      assert.strictEqual(json.providers.pollinations.keyless, true);
      assert.ok(json.providers.gemini, "gemini adapter missing");
      assert.strictEqual(json.providers.gemini.hasKey, false, "no gemini key should exist yet");
      assert.ok(json.providers.ollama && json.providers.openai, "other adapters missing");
      assert.ok(json.active && json.active.id === "pollinations", "pollinations should be active by default");
    });

    await check("POST /api/providers stores a key but never returns it", async () => {
      const FAKE_KEY = "AIzaFAKE_TEST_KEY_123456789";
      const save = await request("POST", "/api/providers", {
        provider: "gemini", apiKey: FAKE_KEY, model: "gemini-2.5-flash", activate: false
      });
      assert.strictEqual(save.status, 200, "save failed: " + save.body);
      assert.ok(!save.body.includes(FAKE_KEY), "save response echoed the key!");
      assert.ok(/ends …6789/.test(save.body), "masked key hint missing: " + save.body);

      const read = await request("GET", "/api/providers");
      assert.ok(!read.body.includes(FAKE_KEY), "GET /api/providers leaked the key!");
      const json = JSON.parse(read.body);
      assert.strictEqual(json.providers.gemini.hasKey, true);

      const cfgText = fs.readFileSync(path.join(TMP_CONFIG, "settings.json"), "utf8");
      assert.ok(cfgText.includes(FAKE_KEY), "key was not persisted in the isolated config");
    });

    await check("unknown provider rejected on save", async () => {
      const res = await request("POST", "/api/providers", { provider: "not-real", activate: true });
      assert.strictEqual(res.status, 400);
    });

    await check("key can be cleared", async () => {
      const res = await request("POST", "/api/providers", { provider: "gemini", apiKey: "CLEAR" });
      assert.strictEqual(res.status, 200);
      const json = JSON.parse((await request("GET", "/api/providers")).body);
      assert.strictEqual(json.providers.gemini.hasKey, false, "key should be gone");
    });

    await check("POST /api/chat validates input before calling any provider", async () => {
      const empty = await request("POST", "/api/chat", {});
      assert.strictEqual(empty.status, 400);
      assert.ok(JSON.parse(empty.body).error.message.length > 0);
      const tooLong = await request("POST", "/api/chat", { message: "x".repeat(9000) });
      assert.strictEqual(tooLong.status, 400);
    });

    await check("chat against Gemini with no key fails with actionable error (no fake reply)", async () => {
      await request("POST", "/api/providers", { provider: "gemini", activate: true });
      const res = await request("POST", "/api/chat", { message: "ping" });
      assert.ok(res.status >= 400, "expected an error, got " + res.status);
      const json = JSON.parse(res.body);
      assert.ok(json.error && json.error.message, "missing error message");
      assert.ok(/Gemini|key/i.test(json.error.message + (json.error.hint || "")), "unhelpful error: " + res.body);
      assert.ok(!json.text, "must not fabricate a reply");
      // Restore the working default.
      await request("POST", "/api/providers", { provider: "pollinations", activate: true });
    });

    await check("config isolated + created with Stage 2 defaults", async () => {
      const cfg = JSON.parse(fs.readFileSync(path.join(TMP_CONFIG, "settings.json"), "utf8"));
      assert.strictEqual(cfg.app.name, "Nexora AI");
      assert.ok(cfg.providers.pollinations, "pollinations default missing");
      assert.ok(cfg.persona && cfg.persona.systemPrompt, "persona missing");
      assert.ok(cfg.studio && cfg.studio.bridgeUrl, "studio bridge default missing");
      // The real project config must be untouched by this test run.
      const realCfg = fs.readFileSync(path.join(ROOT, "config", "settings.json"), "utf8");
      assert.ok(!realCfg.includes("AIzaFAKE_TEST_KEY"), "test polluted the real config file!");
    });

    await check("GET /api/studio/status is honest about no connection", async () => {
      const res = await request("GET", "/api/studio/status?refresh=1");
      assert.strictEqual(res.status, 200);
      const json = JSON.parse(res.body);
      assert.strictEqual(json.connected, false, "must not claim a Studio connection without a real endpoint");
      assert.ok(json.bridgeUrl, "bridge URL should be reported");
      assert.strictEqual(json.toolCount, 0);
      assert.ok(json.detail && json.detail.length > 0, "status should explain why it is disconnected");
    });

    await check("GET /api/studio/mcp/tools refuses without a real connection (409)", async () => {
      const res = await request("GET", "/api/studio/mcp/tools");
      assert.strictEqual(res.status, 409);
      const json = JSON.parse(res.body);
      assert.strictEqual(json.error.code, "STUDIO_DISCONNECTED");
      assert.ok(!json.tools, "must not fabricate a tool list");
    });

    await check("POST /api/studio/mcp/call refuses without a real connection (409)", async () => {
      const res = await request("POST", "/api/studio/mcp/call", { tool: "inspect_instance", args: {} });
      assert.strictEqual(res.status, 409);
      const json = JSON.parse(res.body);
      assert.strictEqual(json.error.code, "STUDIO_DISCONNECTED");
      assert.ok(!json.result, "must not simulate a tool result");
    });

    await check("CSS and JS assets are served with correct types", async () => {
      const css = await request("GET", "/assets/css/nexora.css");
      assert.strictEqual(css.status, 200);
      assert.ok(css.headers["content-type"].includes("text/css"));
      const js = await request("GET", "/assets/js/app.js");
      assert.strictEqual(js.status, 200);
      assert.ok(js.headers["content-type"].includes("javascript"));
      const providers = await request("GET", "/assets/js/providers.js");
      assert.strictEqual(providers.status, 200);
    });

    await check("security headers present (CSP, nosniff)", async () => {
      const res = await request("GET", "/");
      assert.ok(res.headers["content-security-policy"], "CSP missing");
      assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
    });

    await check("config directory is NOT reachable over HTTP", async () => {
      const res = await request("GET", "/config/settings.json");
      assert.ok(res.status === 404 || res.status === 403, "unexpected status " + res.status);
      assert.ok(!res.body.includes("_readme"), "config content leaked!");
    });

    await check("encoded path traversal is blocked", async () => {
      const res = await request("GET", "/%2e%2e/config/settings.json");
      assert.ok(res.status >= 400 && res.status < 500, "unexpected status " + res.status);
      assert.ok(!res.body.includes("_readme"), "traversal leaked config!");
    });

    await check("unknown API endpoint returns JSON 404; bad method 405", async () => {
      const a = await request("GET", "/api/does-not-exist");
      assert.strictEqual(a.status, 404);
      JSON.parse(a.body);
      const b = await request("POST", "/api/health");
      assert.strictEqual(b.status, 405);
      JSON.parse(b.body);
    });

    await check("rate limiter returns 429 after burst", async () => {
      let saw429 = false;
      for (let i = 0; i < 200; i++) {
        const res = await request("GET", "/api/health");
        if (res.status === 429) { saw429 = true; break; }
      }
      assert.ok(saw429, "no 429 received during burst");
    });
  } finally {
    child.kill();
    try { fs.rmSync(TMP_CONFIG, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }

  console.log("\n" + passed + " server tests passed.");
}

main().catch((err) => {
  if (process.exitCode !== 1) {
    console.error("TEST RUN FAILED — " + err.message);
    process.exitCode = 1;
  }
  process.exit();
});
