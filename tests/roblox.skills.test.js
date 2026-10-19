"use strict";
/**
 * Nexora AI — live Roblox developer-intelligence tests (Tests A-D).
 * Runs the real /api/chat pipeline against the configured provider and asserts
 * on the actual answer + the deterministic verification metadata.
 *
 * The keyless Pollinations tier allows 1 reply / 30 s per IP, so calls are paced
 * and one rate-limit retry is attempted. If the provider is unavailable the
 * suite fails with the real error — it never fakes a pass.
 *
 * Run:  node tests/roblox.skills.test.js
 */
const assert = require("assert");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const verifier = require("../server/lib/verify");

const PORT = Number(process.env.NEXORA_SKILLS_PORT || 7897);
const ROOT = path.join(__dirname, "..");
const TMP_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-skills-config-"));
const PACE_MS = 36000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: urlPath, method,
      headers: body
        ? { "content-type": "application/json", "content-length": body.length }
        : {}
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: text, json });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer(child, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    if (child.exitCode !== null) throw new Error("server exited early (code " + child.exitCode + ")");
    try {
      const res = await request("GET", "/api/health");
      if (res.status === 200) return;
    } catch (_) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("server did not start on port " + PORT);
}

let passed = 0;
let failed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  ok  " + label);
  } catch (err) {
    failed += 1;
    process.exitCode = 1;
    console.error("  FAIL " + label + " — " + err.message);
  }
}

const errorFindings = (json) =>
  ((json.verification && json.verification.findings) || []).filter((f) => f.level === "error");

async function chat(payload) {
  let res = await request("POST", "/api/chat", payload);
  // The free tier is flaky: it rate-limits (402) and sometimes answers with an
  // empty body. Retry those transient failures once, honestly, with spacing.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const code = (res.json && res.json.error && res.json.error.code) || "";
    const transient = res.status >= 400 && /RATE_LIMIT|EMPTY|TIMEOUT|NETWORK|UNAVAILABLE/i.test(code + " " + res.body);
    if (!transient) break;
    console.log("    (transient provider failure " + (code || res.status) + " — waiting 34 s, retry " + (attempt + 1) + "/2)");
    await sleep(34000);
    res = await request("POST", "/api/chat", payload);
  }
  if (res.status !== 200) {
    throw new Error("chat failed (" + res.status + "): " + (res.body || "").slice(0, 400));
  }
  assert.ok(res.json && typeof res.json.text === "string" && res.json.text.length > 0, "empty reply");
  assert.ok(res.json.verification && typeof res.json.verification.checked === "boolean", "verification metadata missing");
  return res.json;
}

async function main() {
  console.log("Nexora AI — live Roblox skills tests A-D (port " + PORT + ", isolated config, paced)");

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

  let answerA = null;
  const promptA = [
    "Can you give me a simple example of how to use RemoteEvents in Roblox?",
    "I want to send a message from the client to the server."
  ].join(" ");
  const promptB = [
    "I have an animation with ID 85895369752677. It should play while the player stands on a part called CubePosition,",
    "and the character should look like it is stretching. Right now it keeps restarting and looks wrong.",
    "My Roblox Studio is not connected to you, so don't guess about my project.",
    "Write the LocalScript and tell me how to set it up and test it."
  ].join(" ");
  const promptC = [
    "My RemoteEvent does not work. In a LocalScript I call Remote:FireServer('hi'),",
    "and in a server Script I wrote Remote.OnClientEvent:Connect(function(msg) print(msg) end).",
    "Nothing prints. What is wrong and how do I fix it?"
  ].join(" ");
  const promptD = "Now improve that RemoteEvent example: validate the message on the server so only strings are accepted, and show the updated code.";

  try {
    await waitForServer(child);

    await check("Test A — client→server RemoteEvent example is correct (original prompt)", async () => {
      answerA = await chat({ message: promptA });
      const text = answerA.text;
      assert.ok(/OnServerEvent/.test(text), "answer never uses OnServerEvent (the server receive API)");
      assert.ok(/FireServer/.test(text), "answer never uses FireServer (the client send API)");
      assert.strictEqual(errorFindings(answerA).length, 0, "verifier still flags errors: " + JSON.stringify(errorFindings(answerA)));
      const local = verifier.verifyAnswer(text, { request: promptA });
      assert.strictEqual(local.stats.errors, 0, "independent re-check found errors: " + JSON.stringify(local.findings.filter((f) => f.level === "error")));
      console.log("    answer length: " + text.length + " chars, repair rounds: " + answerA.verification.repairRounds);
    });
    await sleep(PACE_MS);

    await check("Test B — animation 85895369752677: honest disconnect + play-once guard", async () => {
      const res = await chat({ message: promptB });
      const text = res.text;
      assert.ok(text.includes("85895369752677"), "animation id missing from the answer");
      assert.ok(/(LoadAnimation|AnimationId)/.test(text), "no animation loading code");
      assert.ok(/(IsPlaying|playing|once|guard|stop|track)/i.test(text), "no play-once/guard guidance");
      const honest = /(can[’']?t|cannot|unable|not connected|disconnected|don[’']?t have access|no access|need (to see|more)|share|screenshot|which|what is|is it|assuming|clarif)/i;
      assert.ok(honest.test(text), "answer did not acknowledge it cannot inspect the project or ask for the missing detail; head: " + text.slice(0, 300).replace(/\s+/g, " "));
      assert.ok(!/(I (have )?inspected|I can see your (game|project|place)|I looked at your)/i.test(text), "pretended to inspect the project");
      assert.strictEqual(errorFindings(res).length, 0, "verifier flags: " + JSON.stringify(errorFindings(res)));
    });
    await sleep(PACE_MS);

    await check("Test C — debugging the OnClientEvent-in-server-Script mistake", async () => {
      const res = await chat({ message: promptC });
      const text = res.text;
      assert.ok(/OnServerEvent/.test(text), "did not give the correct server listener");
      assert.ok(/OnClientEvent/.test(text), "did not explain which listener was misused");
      assert.strictEqual(errorFindings(res).length, 0, "verifier flags: " + JSON.stringify(errorFindings(res)));
    });
    await sleep(PACE_MS);

    await check("Test D — follow-up uses history and adds validation", async () => {
      assert.ok(answerA, "Test A produced no answer to build on");
      const res = await chat({
        message: promptD,
        history: [
          { role: "user", content: promptA },
          { role: "assistant", content: answerA.text }
        ]
      });
      const text = res.text;
      assert.ok(/(RemoteEvent|FireServer|OnServerEvent)/.test(text), "follow-up lost the RemoteEvent context");
      assert.ok(/(typeof|type\s*\(|is a string|not a string|string check)/i.test(text), "no server-side string validation added");
      assert.strictEqual(errorFindings(res).length, 0, "verifier flags: " + JSON.stringify(errorFindings(res)));
    });
  } catch (err) {
    if (!process.exitCode) process.exitCode = 1;
    console.error("\nSuite stopped: " + err.message);
    if (serverLog.trim()) console.error("--- server log ---\n" + serverLog.slice(-3000));
  } finally {
    child.kill();
    try { fs.rmSync(TMP_CONFIG, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    console.log("\n" + passed + " live Roblox skill tests passed." + (process.exitCode ? " (with failures)" : ""));
  }
}

main();
