"use strict";
/**
 * Nexora AI — Roblox answer verifier (Stage 2.5).
 *
 * A deterministic, dependency-free checker that runs over every AI answer
 * BEFORE it is shown to the user. It encodes the exact mistake class the
 * project was built to eliminate: wrong event directions
 * (e.g. `Remote.OnClientEvent` inside a server Script), APIs used from the
 * wrong execution context, wrong class of remote, syntax/block errors,
 * per-frame animation restarts, missing validation of client input, and
 * missing "where does this script go" guidance.
 *
 * It never "tests" code — it statically reviews the answer. Findings are used
 * for (a) an automatic correction round with the model and (b) honest
 * reporting to the user when issues remain.
 *
 * Exports are pure functions so they can be unit-tested without Studio or AI.
 */

/* ----------------------------- code extraction ---------------------------- */

/** Strip comments and string literals so keyword/delimiter checks are reliable. */
function stripCode(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const two = code.substr(i, 2);
    if (two === "--") {
      const ni = code.indexOf("\n", i);
      i = ni === -1 ? n : ni;
      continue;
    }
    if (two === "[[" || two === "[=" ) {
      // long bracket string [[ ... ]] or [=[ ... ]=]
      const m = /^\[(=*)\[/.exec(code.slice(i));
      if (m) {
        const close = "]" + m[1] + "]";
        const end = code.indexOf(close, i + m[0].length);
        i = end === -1 ? n : end + close.length;
        out += '""';
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === quote) break;
        if (code[j] === "\n") break; // unterminated single-line string
        j++;
      }
      if (j >= n || code[j] !== quote) {
        // keep a marker so the caller can flag the unterminated string
        out += quote === '"' ? "__UNTERMINATED_STRING__" : "__UNTERMINATED_STRING__";
        i = j >= n ? n : j;
        continue;
      }
      out += '""';
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const SERVER_MARKERS = /server\s*(?:[-–—]?\s*script|side)|serverscriptservice|serverstorage|on the server|--\s*server|\bscript \(server\)|server\b/i;
const CLIENT_MARKERS = /local\s*script|client[- ]side|on the client|starterplayerscripts|startercharacterscripts|startergui|playergui|--\s*client/i;
const MODULE_MARKERS = /module\s*script/i;

const CLIENT_TOKENS = [
  /\bLocalPlayer\b/, /UserInputService/, /ContextActionService/, /RunService\.RenderStepped/,
  /workspace\.CurrentCamera/, /player\.PlayerGui/, /:GetMouse\(\)/, /StarterGui\.SetCore/
];
const SERVER_TOKENS = [
  /DataStoreService/, /ServerStorage/, /ServerScriptService/, /OnServerEvent/, /FireAllClients/,
  /OnServerInvoke/, /:FireClient\(/, /Players\.PlayerAdded/
];

function lastMatchIndex(re, text) {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m;
  let last = -1;
  while ((m = global.exec(text)) !== null) {
    last = m.index;
    if (m.index === global.lastIndex) global.lastIndex++; // avoid zero-length loops
  }
  return last;
}

/**
 * Decide where a code block is meant to run from the surrounding prose and the
 * code itself. The NEAREST label wins (a later "LocalScript" heading overrides
 * an earlier "ServerScriptService" one). Returns "server" | "client" | "module" | "unknown".
 */
function detectContext(prose, code) {
  const window = String(prose || "").slice(-500);
  const noLocal = window.replace(/local\s*script/gi, "__LS__").replace(/module\s*script/gi, "__MS__");

  let serverIdx = lastMatchIndex(SERVER_MARKERS, noLocal);
  const bareScript = /\bscript\b/i.exec(noLocal);
  if (bareScript && serverIdx < 0) serverIdx = bareScript.index;
  const clientIdx = lastMatchIndex(CLIENT_MARKERS, window);
  const moduleIdx = lastMatchIndex(MODULE_MARKERS, window);

  const best = Math.max(serverIdx, clientIdx, moduleIdx);
  if (best >= 0) {
    if (moduleIdx === best && moduleIdx > clientIdx && moduleIdx > serverIdx) return "module";
    if (clientIdx === best && clientIdx > serverIdx) return "client";
    if (serverIdx === best && serverIdx > clientIdx) return "server";
  }

  // No explicit marker in the prose: infer from the code's own tokens.
  const clientTokens = CLIENT_TOKENS.filter((re) => re.test(code)).length;
  const serverTokens = SERVER_TOKENS.filter((re) => re.test(code)).length;
  if (clientTokens >= 1 && serverTokens === 0) return "client";
  if (serverTokens >= 1 && clientTokens === 0) return "server";
  return "unknown";
}

/** Extract fenced code blocks with their detected execution context. */
function extractBlocks(text) {
  const blocks = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lang = (m[1] || "").trim().toLowerCase();
    const code = m[2] || "";
    if (!code.trim()) continue;
    // Only Luau-ish fences are code to check. Ignore output/log/JSON/tree fences
    // so they can't produce bogus syntax findings.
    if (lang && !/^(lua|luau|rbxlua|roblox)$/.test(lang)) continue;
    const prose = text.slice(0, m.index);
    blocks.push({
      lang: lang || "lua",
      code: code,
      context: detectContext(prose, code),
      index: m.index
    });
  }
  return blocks;
}

/* ------------------------------- check helpers --------------------------- */

const REMOTE_OPS = [
  "FireServer", "FireClient", "FireAllClients", "OnServerEvent", "OnClientEvent",
  "InvokeServer", "OnServerInvoke", "InvokeClient", "OnClientInvoke"
];

function collectRemotes(blocks) {
  const map = new Map();
  for (const block of blocks) {
    const stripped = stripCode(block.code);
    for (const op of REMOTE_OPS) {
      const re = new RegExp("([A-Za-z_][A-Za-z0-9_.]*?)\\s*(?::|\\.)\\s*" + op + "\\b", "g");
      let m;
      while ((m = re.exec(stripped)) !== null) {
        const name = m[1].split(".").pop();
        if (!name || /^(RemoteEvent|RemoteFunction)$/.test(name)) continue;
        if (!map.has(name)) map.set(name, []);
        map.get(name).push({ op: op, context: block.context });
      }
    }
  }
  return map;
}

function balanceCheck(code) {
  const s = stripCode(code);
  const pairs = [["(", ")"], ["{", "}"], ["[", "]"]];
  const problems = [];
  for (const [open, close] of pairs) {
    const opens = (s.match(new RegExp("\\" + open, "g")) || []).length;
    const closes = (s.match(new RegExp("\\" + close, "g")) || []).length;
    if (opens !== closes) problems.push(opens + " '" + open + "' vs " + closes + " '" + close + "'");
  }
  // Block keywords: every function/if/for/while/do/repeat needs a matching end/until.
  const forDo = (s.match(/\bfor\b[^\n]*?\bdo\b/g) || []).length;
  const whileDo = (s.match(/\bwhile\b[^\n]*?\bdo\b/g) || []).length;
  const opens =
    (s.match(/\bfunction\b/g) || []).length +
    (s.match(/\bif\b/g) || []).length +
    (s.match(/\bfor\b/g) || []).length +
    (s.match(/\bwhile\b/g) || []).length +
    (s.match(/\bdo\b/g) || []).length -
    forDo - whileDo +
    (s.match(/\brepeat\b/g) || []).length;
  const closes = (s.match(/\bend\b/g) || []).length + (s.match(/\buntil\b/g) || []).length;
  if (opens !== closes) problems.push(opens + " block openers vs " + closes + "'end'/'until'");
  return problems;
}

/* ------------------------------- main check ------------------------------ */

/**
 * @param {string} text   the model's answer
 * @param {object} [opts] { request: the user's message }
 * @returns {{findings: Array<{level,code,message}>, blocks: Array, stats: object}}
 */
function verifyAnswer(text, opts) {
  const findings = [];
  const answer = String(text || "");
  const request = String((opts && opts.request) || "");
  const blocks = extractBlocks(answer);

  const add = (level, code, message) => findings.push({ level, code, message });

  /* 1 + 2 — per-block context and syntax checks */
  let cursor = 0;
  for (const block of blocks) {
    const code = stripCode(block.code);
    const ctx = block.context;
    const where = ctx === "unknown" ? "this code block" : "this " + ctx + " code";

    // Debugging answers deliberately show the WRONG snippet. If the prose right
    // before the block labels it as wrong/before/don't-do, skip static checks so
    // repair rounds never "fix" an explanatory counter-example. Only the prose
    // between the previous block and this one counts.
    const lead = answer.slice(cursor, block.index);
    const closeFence = answer.indexOf("```", block.index + 3);
    cursor = closeFence >= 0 ? closeFence + 3 : block.index + block.code.length;
    if (/(wrong|incorrect|bad (example|version)|don'?t do|do not do|never do|❌|anti-?pattern|before[: ]|previously|the bug|broken (version|code)|instead of)/i.test(lead)) {
      continue;
    }

    if (ctx === "server") {
      if (/\bOnClientEvent\b/.test(code)) {
        add("error", "EVENT_DIRECTION",
          "A server Script listens with `OnClientEvent`. OnClientEvent fires on the CLIENT that received FireClient. Server-side receives must use `OnServerEvent:Connect(function(player, ...))`.");
      }
      if (/\bOnServerInvoke\b/.test(code)) {
        add("error", "EVENT_DIRECTION",
          "`OnServerInvoke` belongs to a RemoteFunction on the server; a RemoteEvent uses `OnServerEvent`.");
      }
      if (/:\s*FireServer\s*\(/.test(code) || /\.\s*FireServer\s*\(/.test(code)) {
        add("error", "EVENT_DIRECTION", "`FireServer` is called by a CLIENT (LocalScript), never from a server Script.");
      }
      if (/\bPlayers\.LocalPlayer\b/.test(code) || /\.\s*LocalPlayer\b/.test(code) && /game\.GetService\(\s*["']Players["']\s*\)\s*\.\s*LocalPlayer/.test(code)) {
        add("error", "CONTEXT", "`LocalPlayer` exists only on the client. On the server use the `player` argument from PlayerAdded / OnServerEvent.");
      }
      if (/RunService\.RenderStepped/.test(code)) {
        add("error", "CONTEXT", "`RunService.RenderStepped` is client-only. On the server use `Heartbeat` (or `Stepped`).");
      }
      if (/\bUserInputService\b/.test(code)) {
        add("error", "CONTEXT", "`UserInputService` is client-only; the server cannot see player input.");
      }
      if (/:InvokeClient\s*\(/.test(code)) {
        add("warn", "EXPLOIT", "`RemoteFunction:InvokeClient` lets a client hang the server. Send data with FireClient/RemoteEvent instead.");
      }
    }

    if (ctx === "client") {
      if (/\bOnServerEvent\b/.test(code)) {
        add("error", "EVENT_DIRECTION",
          "A LocalScript listens with `OnServerEvent`, but OnServerEvent fires on the SERVER. Clients receive server events with `OnClientEvent:Connect(function(...))`.");
      }
      if (/:\s*FireClient\s*\(/.test(code) || /\bFireAllClients\s*\(/.test(code)) {
        add("error", "EVENT_DIRECTION", "`FireClient`/`FireAllClients` are called by the SERVER; a LocalScript uses `FireServer`.");
      }
      if (/\bOnServerInvoke\b/.test(code)) {
        add("error", "CONTEXT", "`OnServerInvoke` runs on the server. A client calls `RemoteFunction:InvokeServer(...)`.");
      }
      if (/\bDataStoreService\b/.test(code)) {
        add("error", "CONTEXT", "`DataStoreService` is server-only and cannot be used from a LocalScript.");
      }
      if (/game\s*:\s*GetService\(\s*["']ServerScriptService["']\s*\)/.test(code) || /\bServerScriptService\b/.test(code)) {
        add("error", "CONTEXT", "`ServerScriptService` is not visible to clients; use ReplicatedStorage for shared assets.");
      }
      if (/\bgame\s*:\s*GetService\(\s*["']ServerStorage["']\s*\)/.test(code)) {
        add("error", "CONTEXT", "`ServerStorage` is not accessible from a LocalScript.");
      }
    }

    // Syntax / structure (all contexts)
    for (const problem of balanceCheck(block.code)) {
      add("error", "SYNTAX", "Possible syntax error in " + where + ": " + problem + ".");
    }
    if (block.code.includes("__UNTERMINATED_STRING__") || /__UNTERMINATED_STRING__/.test(code)) {
      add("error", "SYNTAX", "Unterminated string literal in " + where + ".");
    }
    if (/while\s+true\s+do/.test(code) && !/task\.wait\s*\(|\bwait\s*\(/.test(code)) {
      add("error", "INFINITE_LOOP", "`while true do` without `task.wait()` inside will freeze the game. Add a yield (or use RunService.Heartbeat).");
    }

    // Animation restarted every frame
    const inLoop = /RenderStepped\s*[:.]\s*Connect|Heartbeat\s*[:.]\s*Connect|Stepped\s*[:.]\s*Connect|while\s+true\s+do/.test(code);
    const plays = /:\s*Play\s*\(/.test(code);
    const guarded = /IsPlaying|GetPlayingAnimationTracks|\bplaying\b|alreadyPlaying|playingFlag|debounce|==\s*Enum\.HumanoidStateType|state\s*==/i.test(code);
    if (inLoop && plays && !guarded) {
      add("error", "ANIMATION_LOOP",
        "The animation is started inside a per-frame/looping block with no `IsPlaying` guard, so it restarts every frame. Play it once when the condition becomes true and stop/guard it while the condition stays active.");
    }

    // Class mismatch: RemoteFunction used like a RemoteEvent and vice versa
    const stripped = stripCode(block.code);
    const fnNames = new Set();
    const evNames = new Set();
    const nameRe = /([A-Za-z_][A-Za-z0-9_]*)\s*(?::|\.)\s*(FireServer|FireClient|FireAllClients|OnServerEvent|OnClientEvent|InvokeServer|OnServerInvoke|InvokeClient|OnClientInvoke)\b/g;
    let nm;
    while ((nm = nameRe.exec(stripped)) !== null) {
      const name = nm[1];
      if (/Function/i.test(name)) fnNames.add(nm[2]);
      if (/Event/i.test(name)) evNames.add(nm[2]);
    }
    // Also follow `local X = ...WaitForChild("SomethingFunction")` declarations.
    const declRe = /local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^\n]*?WaitForChild\s*\(\s*["']([^"']+)["']/g;
    let dm;
    while ((dm = declRe.exec(block.code)) !== null) {
      const varName = dm[1];
      const instanceName = dm[2];
      const usesEventOps = new RegExp("\\b" + varName + "\\s*(?::|\\.)\\s*(FireServer|FireClient|FireAllClients|OnServerEvent|OnClientEvent)\\b").test(stripped);
      const usesFnOps = new RegExp("\\b" + varName + "\\s*(?::|\\.)\\s*(InvokeServer|OnServerInvoke|InvokeClient|OnClientInvoke)\\b").test(stripped);
      if (/Function/i.test(instanceName) && usesEventOps) {
        fnNames.add("FireServer");
      }
      if (/Event/i.test(instanceName) && usesFnOps) {
        evNames.add("InvokeServer");
      }
    }
    const wrongOnFunction = ["FireServer", "FireClient", "FireAllClients", "OnServerEvent", "OnClientEvent"].filter((o) => fnNames.has(o));
    if (wrongOnFunction.length) {
      add("warn", "REMOTE_CLASS", "A `RemoteFunction` is being used like a RemoteEvent (" + wrongOnFunction.join(", ") + "). RemoteFunctions use InvokeServer/OnServerInvoke for two-way calls; use a RemoteEvent for one-way events.");
    }
    const wrongOnEvent = ["InvokeServer", "OnServerInvoke", "InvokeClient", "OnClientInvoke"].filter((o) => evNames.has(o));
    if (wrongOnEvent.length) {
      add("warn", "REMOTE_CLASS", "A `RemoteEvent` is being used like a RemoteFunction (" + wrongOnEvent.join(", ") + ").");
    }

    // Server input validation
    if (ctx === "server" && /OnServerEvent\s*:\s*Connect\s*\(\s*function\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/.test(block.code)) {
      const hasValidation = /typeof|tonumber|type\s*\(|math\.clamp|assert\s*\(|validate|isNaN|math\.floor|math\.round/.test(block.code);
      if (!hasValidation) {
        add("warn", "VALIDATION", "The server handler uses values sent by a client without any validation (typeof/tonumber/math.clamp). Validate type and range before trusting them.");
      }
    }

    // Deprecated / risky patterns
    if (/Humanoid\s*:\s*LoadAnimation\s*\(/.test(block.code)) {
      add("warn", "DEPRECATED", "`Humanoid:LoadAnimation` is deprecated; on modern rigs use `humanoid:WaitForChild(\"Animator\"):LoadAnimation(animation)`.");
    }
    if (/Instance\.new\s*\(\s*["'][A-Za-z]+["']\s*,/.test(block.code)) {
      add("warn", "API_USAGE", "`Instance.new(class, parent)` with a second argument is discouraged (properties must be set before parenting for performance). Create the instance, set properties, then assign `.Parent`.");
    }
  }

  /* 3 — cross-block remote direction pairing */
  const remotes = collectRemotes(blocks);
  for (const [name, uses] of remotes) {
    const ops = new Set(uses.map((u) => u.op));
    const has = (o) => ops.has(o);
    if (has("FireServer") && has("OnClientEvent") && !has("OnServerEvent")) {
      add("error", "EVENT_PAIR",
        "`" + name + "` is fired with FireServer (client→server) but the listener is OnClientEvent, which receives FireClient. Add `" + name + ".OnServerEvent:Connect(function(player, ...) end)` on the server (and use FireClient from the server if it must reach clients).");
    }
    if (has("FireClient") && has("OnServerEvent") && !has("OnClientEvent")) {
      add("error", "EVENT_PAIR",
        "`" + name + "` is sent with FireClient (server→client) but listened to with OnServerEvent, which receives FireServer. The client must use `" + name + ".OnClientEvent:Connect(function(...) end)`.");
    }
    if (has("InvokeServer") && !has("OnServerInvoke")) {
      add("warn", "EVENT_PAIR", "`" + name + ":InvokeServer(...)` has no matching `OnServerInvoke` handler on the server.");
    }
    if (has("InvokeClient")) {
      add("warn", "EXPLOIT", "`" + name + ":InvokeClient(...)` is exploitable (a client can never return and stall the server). Prefer FireClient.");
    }
  }

  /* 4 — answer-level guidance checks */
  if (blocks.length > 0) {
    const looksLikeTask = /make|create|write|build|add|script|code|fix|implement|example|system|trigger|play|connect/i.test(request) || blocks.length >= 2;
    const mentionsPlacement = /(LocalScript|ModuleScript|\bScript\b|ServerScriptService|ServerStorage|StarterPlayerScripts|StarterCharacterScripts|StarterGui|ReplicatedStorage|ReplicatedFirst|Workspace)/.test(answer);
    if (looksLikeTask && !mentionsPlacement) {
      add("warn", "PLACEMENT", "The answer does not say where each script belongs (Explorer path) or its type (Script / LocalScript / ModuleScript). Add the exact location for every script.");
    }
    const mentionsTest = /test|expected|output|should (see|print|show)|verify/i.test(answer);
    if (looksLikeTask && blocks.length >= 2 && !mentionsTest) {
      add("warn", "TEST_STEPS", "No testing procedure or expected result was given. Add how to test in Studio and what the user should see.");
    }
  }

  /* 5 - honesty about not seeing the user's own project */
  // If the user talks about THEIR game/objects (or explicitly says Studio is not
  // connected), the answer must say it cannot inspect it / what it is assuming —
  // instead of silently pretending to know their setup.
  const userSpecific =
    /\b(my|our)\b[^.\n]{0,60}\b(game|project|place|script|code|part|model|animation|character|gui|ui|level|map|experience)\b/i.test(request) ||
    /(studio is not connected|not connected to you|can[’']?t see|don[’']?t have access)/i.test(request);
  const acknowledges =
    /(can[’']?t|cannot|unable|not connected|disconnected|don[’']?t have access|no access|without seeing|need (to see|more)|share|screenshot|which (part|script)|assuming|assume|clarif)/i.test(answer);
  if (userSpecific && !acknowledges) {
    add("error", "DISCONNECT_HONESTY",
      "The user asked about THEIR project, but the answer never says that the project cannot be inspected and never lists an assumption. Add one short sentence: state that you cannot see their game (Studio is not connected), name the assumption you are making, and ask for the missing detail if it matters.");
  }

  const order = { error: 0, warn: 1 };
  findings.sort((a, b) => order[a.level] - order[b.level]);

  return {
    findings: findings,
    blocks: blocks.map((b) => ({ context: b.context, lang: b.lang, lines: b.code.split("\n").length })),
    stats: {
      length: answer.length,
      blocks: blocks.length,
      errors: findings.filter((f) => f.level === "error").length,
      warnings: findings.filter((f) => f.level === "warn").length
    }
  };
}

/** Format findings for the model's correction round. */
function findingsPrompt(findings) {
  return findings
    .map((f, i) => (i + 1) + ". [" + (f.level === "error" ? "MUST FIX" : "please fix") + "] " + f.message)
    .join("\n");
}

module.exports = { verifyAnswer, extractBlocks, detectContext, stripCode, findingsPrompt };
