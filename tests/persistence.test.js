"use strict";
/**
 * Nexora AI — Stage 3 persistence test.
 *
 * Boots the real server twice (restart in the middle) with an isolated data
 * directory and proves: projects and conversations are stored, survive a
 * restart, are scoped per device, and reject bad input without crashing.
 *
 *   node tests/persistence.test.js
 */

const assert = require("assert");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.NEXORA_TEST_DATA_PORT || 7897);
const ROOT = path.join(__dirname, "..");
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-test-data-"));
const TMP_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-test-cfg-"));

const DEVICE_A = "dev-aaaaaaaa-1111";
const DEVICE_B = "dev-bbbbbbbb-2222";

function request(method, urlPath, payload, device) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let bodyText = "";
    if (device) headers["X-Nexora-Device"] = device;
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
        res.on("end", () => resolve({ status: res.statusCode, body: body }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(bodyText);
  });
}

function startServer() {
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
  return child;
}

async function waitForServer(child) {
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error("server exited early with code " + child.exitCode);
    try {
      const res = await request("GET", "/api/health");
      if (res.status === 200) return;
    } catch (_e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become ready on port " + PORT);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((resolve) => child.on("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([done, new Promise((r) => setTimeout(r, 4000))]);
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
    console.error("  FAIL " + label + " — " + err.message);
  }
}

const ids = { project: null, conversation: null };

async function main() {
  console.log("Nexora AI — Stage 3 persistence tests (port " + PORT + ")");
  let child = startServer();
  try {
    await waitForServer(child);

    await check("workspace starts empty for a new device", async () => {
      const res = await request("GET", "/api/workspace", undefined, DEVICE_A);
      assert.strictEqual(res.status, 200);
      const json = JSON.parse(res.body);
      assert.deepStrictEqual(json.projects, []);
      assert.deepStrictEqual(json.conversations, []);
    });

    await check("missing device id is rejected, not ignored", async () => {
      const res = await request("GET", "/api/workspace");
      assert.strictEqual(res.status, 400);
      assert.ok(/device/i.test(res.body), "error should name the header");
    });

    await check("project creation persists with a real id", async () => {
      const res = await request("POST", "/api/projects", { name: "Obby Tycoon", description: "Parkour + money" }, DEVICE_A);
      assert.strictEqual(res.status, 201);
      const project = JSON.parse(res.body).project;
      assert.ok(/^p_[0-9a-f]{16}$/.test(project.id), "unexpected id: " + project.id);
      ids.project = project.id;
    });

    await check("conversation is created inside the project", async () => {
      const res = await request("POST", "/api/conversations", { title: "Coin system", projectId: ids.project }, DEVICE_A);
      assert.strictEqual(res.status, 201);
      const conv = JSON.parse(res.body).conversation;
      assert.strictEqual(conv.projectId, ids.project);
      ids.conversation = conv.id;
    });

    await check("messages round-trip and unknown roles are dropped", async () => {
      const messages = [
        { id: "m1", role: "user", content: "How do I make a coin?" },
        { id: "m2", role: "assistant", content: "Use a Part with a touched event." },
        { id: "m3", role: "system", content: "should not be stored" },
        { id: "m4", role: "notice", content: "should not be stored" }
      ];
      const put = await request("PUT", "/api/conversations/" + ids.conversation, { messages: messages, title: "Coin system v2" }, DEVICE_A);
      assert.strictEqual(put.status, 200);
      const got = await request("GET", "/api/conversations/" + ids.conversation, undefined, DEVICE_A);
      const conv = JSON.parse(got.body).conversation;
      assert.strictEqual(conv.title, "Coin system v2");
      assert.strictEqual(conv.messages.length, 2, "only user/assistant should persist");
      assert.strictEqual(conv.messages[1].content, "Use a Part with a touched event.");
    });

    await check("another device cannot see or fetch that data", async () => {
      const list = JSON.parse((await request("GET", "/api/workspace", undefined, DEVICE_B)).body);
      assert.deepStrictEqual(list.projects, []);
      assert.deepStrictEqual(list.conversations, []);
      const one = await request("GET", "/api/conversations/" + ids.conversation, undefined, DEVICE_B);
      assert.strictEqual(one.status, 404);
    });

    await check("invalid ids and bad input are handled, not crashed", async () => {
      const weird = await request("GET", "/api/conversations/" + encodeURIComponent("../config"), undefined, DEVICE_A);
      assert.strictEqual(weird.status, 404);
      const emptyName = await request("POST", "/api/projects", { name: "   " }, DEVICE_A);
      assert.strictEqual(emptyName.status, 400);
      const badProject = await request("POST", "/api/conversations", { projectId: "p_nope" }, DEVICE_A);
      assert.strictEqual(badProject.status, 400);
    });

    await check("project rename updates the workspace listing", async () => {
      const res = await request("PATCH", "/api/projects/" + ids.project, { name: "Obby Tycoon Deluxe" }, DEVICE_A);
      assert.strictEqual(res.status, 200);
      const list = JSON.parse((await request("GET", "/api/workspace", undefined, DEVICE_A)).body);
      const project = list.projects[0];
      assert.strictEqual(project.name, "Obby Tycoon Deluxe");
      assert.strictEqual(project.conversationCount, 1);
    });

    await check("data survives a server restart (file-backed)", async () => {
      await stopServer(child);
      child = startServer();
      await waitForServer(child);
      const list = JSON.parse((await request("GET", "/api/workspace", undefined, DEVICE_A)).body);
      assert.strictEqual(list.projects.length, 1);
      assert.strictEqual(list.conversations.length, 1);
      assert.strictEqual(list.conversations[0].title, "Coin system v2");
      const conv = JSON.parse((await request("GET", "/api/conversations/" + ids.conversation, undefined, DEVICE_A)).body).conversation;
      assert.strictEqual(conv.messages.length, 2);
    });

    await check("deleting a project keeps its chats (detached)", async () => {
      const res = await request("DELETE", "/api/projects/" + ids.project, undefined, DEVICE_A);
      assert.strictEqual(res.status, 200);
      const json = JSON.parse(res.body);
      assert.strictEqual(json.detached, 1);
      const list = JSON.parse((await request("GET", "/api/workspace", undefined, DEVICE_A)).body);
      assert.strictEqual(list.projects.length, 0);
      assert.strictEqual(list.conversations.length, 1);
      assert.strictEqual(list.conversations[0].projectId, null);
    });

    await check("conversation delete removes it for good", async () => {
      const res = await request("DELETE", "/api/conversations/" + ids.conversation, undefined, DEVICE_A);
      assert.strictEqual(res.status, 200);
      const list = JSON.parse((await request("GET", "/api/workspace", undefined, DEVICE_A)).body);
      assert.strictEqual(list.conversations.length, 0);
      const gone = await request("GET", "/api/conversations/" + ids.conversation, undefined, DEVICE_A);
      assert.strictEqual(gone.status, 404);
    });

    await check("stored file exists and contains no plaintext secrets field", async () => {
      const file = path.join(TMP_DATA, "nexora-store.json");
      assert.ok(fs.existsSync(file), "store file missing");
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.version, 1);
      assert.ok(raw.indexOf("apiKey") === -1, "store must not hold provider keys");
    });
  } finally {
    await stopServer(child);
  }

  console.log("\n" + passed + " persistence tests passed" + (failed ? ", " + failed + " failed" : "") + ".");
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("suite crashed: " + err.message);
  process.exitCode = 1;
});
