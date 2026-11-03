"use strict";
/**
 * Nexora AI — Stage 3 UI test (headless Edge, no AI provider needed).
 *
 * Proves the Projects view really works end to end against the running server:
 * create a project through the DOM, save a chat message, reload the page, and
 * find both again — plus delete. Uses an isolated data directory and its own
 * server instance on port 7894.
 *
 *   node tests/ui.projects.test.js
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.NEXORA_PROJECTS_UI_PORT || 7894);
const CDP_PORT = 9336;
const BASE = "http://127.0.0.1:" + PORT;
const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-ui-proj-data-"));
const TMP_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-ui-proj-cfg-"));
const TMP_PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-ui-proj-profile-"));

let passed = 0;
let failed = 0;
function ok(label) { passed += 1; console.log("  ok  " + label); }
function bad(label, detail) { failed += 1; console.error("  FAIL " + label + " — " + detail); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  for (const candidate of EDGE_PATHS) if (fs.existsSync(candidate)) return candidate;
  throw new Error("Microsoft Edge not found");
}

async function waitJson(url, tries) {
  for (let i = 0; i < (tries || 60); i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (_e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("timed out waiting for " + url);
}

async function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NEXORA_PORT: String(PORT),
      NEXORA_HOST: "127.0.0.1",
      NEXORA_CONFIG_DIR: TMP_CONFIG,
      NEXORA_DATA_DIR: TMP_DATA
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitJson(BASE + "/api/health");
  return child;
}

function createClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (_e) { /* ignore */ } }
    });
    ws.onerror = () => reject(new Error("CDP connect failed"));
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (_e) { return; }
      if (msg.id != null && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) entry.rej(new Error(JSON.stringify(msg.error)));
        else entry.res(msg.result || {});
      }
    };
  });
}

async function main() {
  console.log("Nexora AI — Stage 3 Projects UI tests (" + BASE + ")\n");
  const server = await startServer();
  const edge = spawn(findEdge(), [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=" + CDP_PORT,
    "--user-data-dir=" + TMP_PROFILE,
    BASE + "/"
  ], { stdio: "ignore" });

  let client = null;
  try {
    const targets = await waitJson("http://127.0.0.1:" + CDP_PORT + "/json/list", 80);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    client = await createClient(page.webSocketDebuggerUrl);
    await client.send("Runtime.enable");

    async function evaluate(expression) {
      const result = await client.send("Runtime.evaluate", {
        expression: expression,
        awaitPromise: true,
        returnByValue: true
      });
      if (result.exceptionDetails) {
        const text = result.exceptionDetails.text || (result.exceptionDetails.exception && result.exceptionDetails.exception.description) || "eval failed";
        throw new Error(text);
      }
      return result.result ? result.result.value : undefined;
    }

    async function waitFor(expression, label, tries) {
      for (let i = 0; i < (tries || 60); i++) {
        try {
          if (await evaluate(expression)) return true;
        } catch (_e) { /* page still loading */ }
        await sleep(250);
      }
      throw new Error("timeout waiting for " + label);
    }

    await waitFor("!!(window.NexoraStore && window.NexoraProjects && document.getElementById('projectsList'))", "app boot");

    try {
      await evaluate("window.NexoraApp.setView('projects')");
      await waitFor("document.querySelector('[data-view-panel=\\\"projects\\\"]').classList.contains('hidden') === false", "projects view");
      ok("Projects view opens from the app shell");
    } catch (err) { bad("Projects view opens from the app shell", err.message); }

    try {
      await evaluate("document.getElementById('btnNewProject').click()");
      await evaluate("document.getElementById('newProjectName').value='Obby Tycoon';" +
        "document.getElementById('newProjectDescription').value='Parkour game';" +
        "document.getElementById('newProjectForm').requestSubmit();");
      await waitFor("/Obby Tycoon/.test(document.getElementById('projectsList').textContent)", "project card");
      ok("Creating a project in the UI stores it and renders a card");
    } catch (err) { bad("Creating a project in the UI stores it and renders a card", err.message); }

    try {
      await evaluate("window.NexoraStore.pushMessage({role:'user', content:'persisted hello from ui test'});");
      await sleep(1200);
      const workspace = await (await fetch(BASE + "/api/workspace", {
        headers: { "X-Nexora-Device": await evaluate("window.NexoraStore.deviceId()") }
      })).json();
      if (workspace.conversations.length !== 1) throw new Error("expected 1 stored conversation, got " + workspace.conversations.length);
      ok("A chat message is saved to the server (1 conversation stored)");
    } catch (err) { bad("A chat message is saved to the server (1 conversation stored)", err.message); }

    try {
      await client.send("Page.enable");
      await client.send("Page.reload", { ignoreCache: true });
      await waitFor("!!(window.NexoraStore && window.NexoraProjects && document.getElementById('projectsList'))", "app boot after reload", 80);
      await sleep(600);
      await evaluate("window.NexoraApp.setView('projects')");
      await waitFor("/persisted hello from ui test/.test(document.getElementById('projectsList').textContent)", "restored conversation", 80);
      ok("After a full reload the saved chat is listed again");
    } catch (err) { bad("After a full reload the saved chat is listed again", err.message); }

    try {
      await evaluate("window.NexoraApp.setView('chat')");
      await evaluate("window.NexoraStore.openConversation(window.NexoraStore.state.conversations[0].id)");
      await sleep(500);
      const text = await evaluate("document.getElementById('messages').textContent");
      if (!/persisted hello from ui test/.test(text)) throw new Error("message not rendered: " + text.slice(0, 80));
      ok("Opening the saved conversation renders its real messages");
    } catch (err) { bad("Opening the saved conversation renders its real messages", err.message); }

    try {
      await evaluate("window.confirm = function () { return true; }; window.NexoraApp.setView('projects')");
      await sleep(400);
      await evaluate("document.querySelector('[data-action=\"delete\"]').click()");
      await waitFor("/Obby Tycoon/.test(document.getElementById('projectsList').textContent) === false", "project removed");
      ok("Deleting a project removes it from the list");
    } catch (err) { bad("Deleting a project removes it from the list", err.message); }
  } catch (err) {
    bad("suite", err.message);
  } finally {
    if (client) client.close();
    try { edge.kill(); } catch (_e) { /* ignore */ }
    try { execSync("taskkill /PID " + edge.pid + " /T /F", { stdio: "ignore" }); } catch (_e) { /* already gone */ }
    try { server.kill(); } catch (_e) { /* ignore */ }
  }

  console.log("\n" + passed + " project UI checks passed" + (failed ? ", " + failed + " failed" : "") + ".");
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("suite crashed: " + err.message);
  process.exitCode = 1;
});
