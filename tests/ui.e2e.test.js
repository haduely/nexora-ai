"use strict";
/**
 * Nexora AI ??? end-to-end UI test against the RUNNING server (default :7810).
 *
 * Stage 2 scope: verifies real AI chat through the active provider.
 *  - a real model reply appears in the conversation (Pollinations, keyless)
 *  - a follow-up question proves conversation history reaches the model
 *  - an invalid Gemini key produces a clear error bubble (no fake reply)
 *  - Retry re-sends the same message after fixing the provider
 *  - navigation, Projects, Studio, Settings still work
 *
 * Prerequisite: nexora-ai server running. Run:  node tests/ui.e2e.test.js
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.NEXORA_PORT || 7810);
const BASE = "http://127.0.0.1:" + PORT;
const CDP_PORT = 9334;
const REPLY_TIMEOUT = 120_000;

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

let passed = 0;
function ok(label) {
  passed += 1;
  console.log("  ok  " + label);
}
function fail(label, detail) {
  console.error("  FAIL " + label + " ??? " + detail);
  process.exitCode = 1;
  throw new Error(label + ": " + detail);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkServer() {
  try {
    const res = await fetch(BASE + "/api/health");
    const h = await res.json();
    if (h.stage < 2) throw new Error("server is Stage " + h.stage + "; Stage 2 required");
    return h;
  } catch (err) {
    console.error("Nexora Stage 2 server is not reachable at " + BASE + " (" + err.message + ").");
    console.error("Start it first:  powershell -File start.ps1");
    process.exit(1);
  }
}

/* ------------------------- minimal CDP client ------------------------- */

function createClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = [];
    let nextId = 1;
    ws.onopen = () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        on(fn) { listeners.push(fn); },
        close() { try { ws.close(); } catch (_e) { /* ignore */ } }
      });
    };
    ws.onerror = (e) => reject(new Error("CDP WebSocket error: " + (e.message || "connect failed")));
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (_e) { return; }
      if (msg.id != null && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result || {});
      } else {
        for (const fn of listeners) fn(msg);
      }
    };
  });
}

/* --------------------------------- main -------------------------------- */

async function main() {
  console.log("Nexora AI ??? Stage 2 end-to-end UI tests (" + BASE + ")\n");
  await checkServer();

  const edge = EDGE_PATHS.find((p) => fs.existsSync(p));
  if (!edge) fail("locate Edge", "msedge.exe not found");

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-e2e2-"));
  const edgeProc = spawn(
    edge,
    [
      "--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking",
      "--no-default-browser-check", "--user-data-dir=" + profile,
      "--remote-debugging-port=" + CDP_PORT, "--window-size=1440,1000", "about:blank"
    ],
    { stdio: "ignore" }
  );

  const pageErrors = [];
  let client;
  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(150);
      try {
        const list = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/list")).json();
        target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      } catch (_e) { /* not up yet */ }
    }
    if (!target) fail("connect to Edge", "DevTools endpoint never appeared");

    client = await createClient(target.webSocketDebuggerUrl);
    client.on((msg) => {
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        pageErrors.push((d.exception && d.exception.description) || d.text || "unknown exception");
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry && msg.params.entry.level === "error") {
        const text = msg.params.entry.text;
        // "Failed to load resource" entries are HTTP responses seen by the page
        // (e.g. the intentional 502 from the invalid-Gemini-key test) ??? the app
        // handles those in-UI. Only unexpected log errors count as page errors.
        if (!/task provider|GroupMarkerNot|Failed to load resource/i.test(text)) pageErrors.push(text);
      }
    });

    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    await client.send("Page.navigate", { url: BASE + "/" });

    async function evalJs(expression) {
      const r = await client.send("Runtime.evaluate", {
        expression, returnByValue: true, awaitPromise: true
      });
      if (r.exceptionDetails) {
        throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
      }
      return r.result ? r.result.value : undefined;
    }

    async function waitFor(expression, label, timeoutMs) {
      const start = Date.now();
      const limit = timeoutMs || 8000;
      let last;
      while (Date.now() - start < limit) {
        last = await evalJs(expression);
        if (last) return last;
        await sleep(250);
      }
      fail(label, "timed out after " + limit + "ms (last value: " + JSON.stringify(last) + ")");
    }

    async function sendChat(text) {
      await evalJs(`
        (function(){
          var input = document.getElementById('composerInput');
          input.value = ${JSON.stringify(text)};
          input.dispatchEvent(new Event('input', {bubbles:true}));
          document.getElementById('btnSend').click();
          return true;
        })()
      `);
    }

    const countAssistant = "document.querySelectorAll('.msg.assistant:not(.typing)').length";

    // Wait for a new assistant reply after `before` assistant messages exist.
    // Fails FAST (with the provider's real error text) if an error bubble
    // appears instead ??? a failed request must never be mistaken for a timeout.
    async function waitForAssistant(before, label) {
      const errBefore = await evalJs("document.querySelectorAll('.msg.error').length");
      const value = await waitFor(
        "(function(){var e=document.querySelectorAll('.msg.error');" +
        "if(e.length>" + errBefore + "){return 'ERROR_BUBBLE::'+e[e.length-1].textContent.trim();}" +
        "var m=document.querySelectorAll('.msg.assistant:not(.typing)');" +
        "if(m.length>" + before + "){var t=m[m.length-1].textContent.trim();" +
        "if(t.length>0) return t;} return null;})()",
        label,
        REPLY_TIMEOUT
      );
      if (typeof value === "string" && value.indexOf("ERROR_BUBBLE::") === 0) {
        fail(label, "provider returned an error instead of a reply: " + value.slice(14, 300));
      }
      return value;
    }

    /* ------------------------------ boot checks ------------------------------ */

    await waitFor(
      "document.readyState==='complete' && !!window.NexoraApp && !!window.NexoraChat && !!window.NexoraProviders",
      "app boot"
    );
    ok("application boots (NexoraApp + Chat + Providers loaded)");

    await waitFor(
      "document.getElementById('modelsSummary').textContent.indexOf('Active:') === 0",
      "active provider status rendered"
    );
    ok("Models summary shows the live active provider from the server");

    const cardCount = await evalJs("document.querySelectorAll('.provider-card').length");
    if (cardCount !== 4) fail("provider cards", "expected 4 cards, got " + cardCount);
    const activeBadge = await evalJs("document.querySelectorAll('.provider-card .active-badge').length");
    if (activeBadge !== 1) fail("active badge", "expected exactly 1 ACTIVE badge, got " + activeBadge);
    ok("Models view renders 4 provider cards with one ACTIVE provider");

    /* ---------------------------- navigation checks --------------------------- */

    for (const view of ["projects", "studio", "models", "settings", "chat"]) {
      await evalJs("document.querySelector('.nav-item[data-view=\"" + view + "\"]').click()");
      const visible = await evalJs(
        "(function(){var p=document.querySelector('[data-view-panel=\"" + view + "\"]');" +
        "var active=document.querySelector('.nav-item.active').getAttribute('data-view');" +
        "return !p.classList.contains('hidden') && active==='" + view + "';})()"
      );
      if (!visible) fail("navigate to " + view, "panel or active state wrong");
    }
    ok("all five views still navigate correctly (Projects, Studio, Settings intact)");

    await evalJs("document.querySelector('.nav-item[data-view=\"settings\"]').click()");
    await waitFor("document.getElementById('setServerHealth').textContent === 'ok'", "settings health");
    const stageText = await evalJs("document.getElementById('setBuildStage').textContent");
    if (!/Stage 2/.test(stageText)) fail("build stage label", "got: " + stageText);
    ok("Settings shows live health and Stage 2 label");

    await evalJs("document.querySelector('.nav-item[data-view=\"studio\"]').click()");
    const studioText = await evalJs("document.querySelector('[data-view-panel=\"studio\"]').textContent");
    if (!/Disconnected/.test(studioText)) fail("studio status", "missing Disconnected");
    ok("Studio still honestly reports Disconnected");

    /* --------------------- composer behavior (pre-chat) ----------------------- */

    await evalJs("document.querySelector('.nav-item[data-view=\"chat\"]').click()");
    await evalJs("document.querySelector('.suggestion').click()");
    const chipValue = await evalJs("document.getElementById('composerInput').value");
    if (!chipValue || chipValue.length < 10) fail("suggestion chip", "value: " + JSON.stringify(chipValue));
    await evalJs("document.getElementById('composerInput').value=''; document.getElementById('composerInput').dispatchEvent(new Event('input',{bubbles:true}))");
    ok("example prompts still fill the composer");

    /* ==================== REAL AI CHAT (live provider) ==================== */
    // Pollinations' free tier allows 1 reply / 30s per IP. The test paces its
    // Pollinations sends accordingly (Gemini-error steps don't consume it).
    const POLLINATIONS_PACE_MS = 31_000;
    async function pacePollinations() { await sleep(POLLINATIONS_PACE_MS); }

    const before0 = await evalJs(countAssistant);
    await sendChat("Reply with exactly this word and nothing else: PONG");
    const typingShown = await waitFor(
      "document.getElementById('nxTyping') !== null || document.querySelectorAll('.msg.assistant:not(.typing)').length > " + before0,
      "typing indicator",
      5000
    );
    ok("typing indicator shown while waiting for the model");
    const pong = await waitForAssistant(before0, "real PONG reply");
    if (!/PONG/i.test(pong)) fail("real model reply", "expected PONG, got: " + pong.slice(0, 200));
    if (/status notice/i.test(pong)) fail("real model reply", "got a status notice instead of a model reply");
    ok("REAL model reply received through the chat UI: '" + pong.trim().slice(0, 60) + "'");

    /* ------------------- follow-up with conversation history ------------------ */

    await pacePollinations();
    const before1 = await evalJs(countAssistant);
    await sendChat("Remember this important fact: the magic codeword is BANANA. Reply with just OK.");
    await waitForAssistant(before1, "codeword ack reply");
    ok("follow-up #1 answered (history turn 1)");

    await pacePollinations();
    const before2 = await evalJs(countAssistant);
    await sendChat("What is the magic codeword I asked you to remember? Reply with only the word.");
    const recall = await waitForAssistant(before2, "codeword recall reply");
    if (!/BANANA/i.test(recall)) {
      fail("conversation history", "model did not recall the codeword; got: " + recall.slice(0, 200));
    }
    ok("follow-up recalled 'BANANA' ??? conversation history reaches the model");

    /* --------------------- invalid provider ??? clear error --------------------- */

    await evalJs("document.querySelector('.nav-item[data-view=\"models\"]').click()");
    await waitFor("document.querySelectorAll('.provider-card').length === 4", "models cards again");
    await evalJs(`
      (function(){
        var card = document.querySelector('.provider-card[data-provider="gemini"]');
        var key = card.querySelector('#pf-gemini-key');
        key.value = 'AIzaINVALID_KEY_FOR_E2E_TEST';
        card.querySelector('button[data-act="save"]').click();
        return true;
      })()
    `);
    await waitFor(
      "document.querySelector('.provider-card[data-provider=\"gemini\"]').classList.contains('active')",
      "gemini activated with invalid key",
      15000
    );
    ok("configured Gemini with an intentionally invalid key (saved server-side, key hidden)");

    await evalJs("document.querySelector('.nav-item[data-view=\"chat\"]').click()");
    const before3 = await evalJs(countAssistant);
    await sendChat("ping");
    const errText = await waitFor(
      "(function(){var e=document.querySelectorAll('.msg.error');" +
      "if(e.length) return e[e.length-1].textContent; return null;})()",
      "error bubble for invalid key",
      REPLY_TIMEOUT
    );
    if (!/key/i.test(errText)) fail("invalid key error", "unhelpful error: " + errText.slice(0, 200));
    const assistantDuringError = await evalJs(countAssistant);
    if (assistantDuringError > before3) fail("invalid key error", "a fake assistant reply appeared during failure!");
    const hintOk = await evalJs(
      "(function(){var e=document.querySelectorAll('.msg.error');" +
      "return /aistudio|Gemini|google/i.test(e[e.length-1].textContent);})()"
    );
    if (!hintOk) fail("error hint", "no actionable hint in error bubble");
    ok("invalid key produced a clear error with an actionable hint ??? and NO fabricated reply");

    const userStillThere = await evalJs(
      "(function(){var u=document.querySelectorAll('.msg.user');" +
      "return u.length>0 && /ping/.test(u[u.length-1].textContent);})()"
    );
    if (!userStillThere) fail("message retention", "user message lost after error");
    ok("failed message kept in the conversation for retry");

    /* -------------------- restore provider ??? Retry succeeds -------------------- */

    await evalJs("document.querySelector('.nav-item[data-view=\"models\"]').click()");
    await evalJs(`
      (function(){
        var card = document.querySelector('.provider-card[data-provider="pollinations"]');
        card.querySelector('button[data-act="save"]').click();
        return true;
      })()
    `);
    await waitFor(
      "document.querySelector('.provider-card[data-provider=\"pollinations\"]').classList.contains('active')",
      "pollinations re-activated",
      15000
    );
    ok("re-activated Pollinations in Models");

    await evalJs("document.querySelector('.nav-item[data-view=\"chat\"]').click()");
    await pacePollinations();
    const before4 = await evalJs(countAssistant);
    await evalJs("document.querySelector('.msg.error .retry-btn').click()");
    await waitForAssistant(before4, "retry success reply");
    ok("Retry re-sent the original message and a real reply arrived");

    const errorsLeft = await evalJs("document.querySelectorAll('.msg.error').length");
    if (Number(errorsLeft) !== 0) fail("retry cleanup", "error bubbles still present: " + errorsLeft);
    ok("error bubble cleared after successful retry");

    await sleep(400);
    if (pageErrors.length > 0) fail("no page errors", pageErrors.join(" | "));
    ok("zero uncaught page errors during the whole run");
  } finally {
    // Mobile viewport sanity check (emulate a 390x844 phone, DPR 3)
    try {
      await client.send("Emulation.setDeviceMetricsOverride", {
        mobile: true,
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        screenOrientation: { type: "portraitPrimary", angle: 0 }
      });
      await sleep(200);
      const mobile = await client.send("Runtime.evaluate", {
        expression: "(function(){var input=document.querySelector('#composerInput');var sidebar=document.querySelector('#sidebar');var menu=document.querySelector('#btnMenu');if(!input||!sidebar||!menu)return {ok:false,why:'missing controls'};var vw=window.innerWidth;var overflow=document.documentElement.scrollWidth-vw;var localOnly=vw===390;return {ok:localOnly&&overflow<=2,why:'vw='+vw+' overflow='+overflow};})()",
        returnByValue: true
      });
      const mres = (mobile.result && mobile.result.value) || { ok: false, why: "no result" };
      if (mres.ok) ok("mobile viewport (390x844) lays out with no horizontal overflow");
      else fail("mobile viewport layout", String(mres.why));
      await client.send("Emulation.clearDeviceMetricsOverride", {});
      await sleep(150);
    } catch (e) { fail("mobile viewport emulation", String((e && e.message) || e)); }

    // Always leave the user's config clean: drop the test Gemini key, keep Pollinations active.
    try {
      await fetch(BASE + "/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini", apiKey: "CLEAR" })
      });
      await fetch(BASE + "/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "pollinations", activate: true })
      });
    } catch (_e) { /* server may already be down */ }

    if (client) client.close();
    try { edgeProc.kill(); } catch (_e) { /* ignore */ }
    try { execSync("taskkill /T /F /PID " + edgeProc.pid, { stdio: "ignore" }); } catch (_e) { /* gone */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }

  console.log("\n" + passed + " UI end-to-end tests passed.");
}

main().catch((err) => {
  if (process.exitCode !== 1) {
    console.error("\nUI TEST RUN FAILED ??? " + err.message);
    process.exitCode = 1;
  }
  process.exit();
});


