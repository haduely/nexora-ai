"use strict";
/**
 * Nexora AI — Roblox intelligence unit tests (no server, no AI, no network).
 * Proves the verifier catches the exact mistake classes this upgrade targets,
 * including the original bug: `Remote.OnClientEvent` inside a server Script.
 * Run:  node tests/verify.test.js
 */
const assert = require("assert");
const verifier = require("../server/lib/verify");
const prompt = require("../server/lib/prompt");

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok  " + label);
  } catch (err) {
    console.error("  FAIL " + label + " — " + err.message);
    process.exitCode = 1;
    throw err;
  }
}

const codes = (result) => result.findings.map((f) => f.code);

/* ------------------------------ Test context ---------------------------- */

check("detects server/client contexts from headings", () => {
  const text = [
    "**1) Server Script — ServerScriptService.RemoteHandler**",
    "```lua",
    "local Remote = game:GetService('ReplicatedStorage'):WaitForChild('Ping')",
    "Remote.OnClientEvent:Connect(function()",
    "  print('wrong')",
    "end)",
    "```",
    "**2) LocalScript — StarterPlayerScripts.PingClient**",
    "```lua",
    "local Remote = game:GetService('ReplicatedStorage'):WaitForChild('Ping')",
    "Remote.OnClientEvent:Connect(function()",
    "  print('right')",
    "end)",
    "```"
  ].join("\n");
  const blocks = verifier.extractBlocks(text);
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].context, "server");
  assert.strictEqual(blocks[1].context, "client");
});

/* ------------------------- Original bug regression ---------------------- */

check("ORIGINAL BUG: OnClientEvent inside a server Script is an error", () => {
  const answer = [
    "Put this in **ServerScriptService**:",
    "```lua",
    "local Remote = game.ReplicatedStorage:WaitForChild('MessageEvent')",
    "Remote.OnClientEvent:Connect(function(message)",
    "  print(message)",
    "end)",
    "```"
  ].join("\n");
  const result = verifier.verifyAnswer(answer, { request: "make a RemoteEvent example" });
  assert.ok(codes(result).includes("EVENT_DIRECTION"), "expected EVENT_DIRECTION, got: " + JSON.stringify(result.findings));
});

check("correct server OnServerEvent is NOT flagged", () => {
  const answer = [
    "Place this in **ServerScriptService** (a Script):",
    "```lua",
    "local ReplicatedStorage = game:GetService('ReplicatedStorage')",
    "local Remote = ReplicatedStorage:WaitForChild('MessageEvent')",
    "Remote.OnServerEvent:Connect(function(player, message)",
    "  if typeof(message) ~= 'string' then return end",
    "  print(player.Name .. ': ' .. message)",
    "end)",
    "```"
  ].join("\n");
  const result = verifier.verifyAnswer(answer, { request: "make a RemoteEvent example" });
  assert.strictEqual(result.stats.errors, 0, "unexpected errors: " + JSON.stringify(result.findings));
});

check("client listening with OnServerEvent is an error", () => {
  const answer = [
    "**LocalScript — StarterPlayerScripts.Client**",
    "```lua",
    "local Remote = game.ReplicatedStorage:WaitForChild('MessageEvent')",
    "Remote.OnServerEvent:Connect(function(message)",
    "  print(message)",
    "end)",
    "```"
  ].join("\n");
  const result = verifier.verifyAnswer(answer, { request: "receive an event" });
  assert.ok(codes(result).includes("EVENT_DIRECTION"));
});

check("FireServer in a server Script is an error", () => {
  const answer = [
    "**Server Script — ServerScriptService.Handler**",
    "```lua",
    "local Remote = game.ReplicatedStorage:WaitForChild('Ping')",
    "Remote:FireServer('hello')",
    "```"
  ].join("\n");
  const result = verifier.verifyAnswer(answer);
  assert.ok(codes(result).includes("EVENT_DIRECTION"));
});

check("FireClient in a LocalScript is an error", () => {
  const answer = [
    "**LocalScript — StarterPlayerScripts.Client**",
    "```lua",
    "local Remote = game.ReplicatedStorage:WaitForChild('Notify')",
    "Remote:FireClient(game.Players.LocalPlayer, 'hi')",
    "```"
  ].join("\n");
  const result = verifier.verifyAnswer(answer);
  assert.ok(codes(result).includes("EVENT_DIRECTION"));
});

check("FireServer with OnClientEvent listener is a pairing error", () => {
  const answer = [
    "**LocalScript — StarterPlayerScripts.A**",
    "```lua",
    "local Remote = game.ReplicatedStorage:WaitForChild('Ping')",
    "Remote:FireServer('hello')",
    "```",
    "**Server Script — ServerScriptService.B**",
    "```lua",
    "local Remote = game.ReplicatedStorage:WaitForChild('Ping')",
    "Remote.OnClientEvent:Connect(function(msg) print(msg) end)",
    "```"
  ].join("\n");
  const result = verifier.verifyAnswer(answer);
  assert.ok(codes(result).includes("EVENT_PAIR"), JSON.stringify(result.findings));
});

/* --------------------------- Context mistakes --------------------------- */

check("LocalPlayer in a server Script is an error", () => {
  const answer = [
    "**Server Script — ServerScriptService.Test**",
    "```lua",
    "local player = game.Players.LocalPlayer",
    "print(player.Name)",
    "```"
  ].join("\n");
  assert.ok(codes(verifier.verifyAnswer(answer)).includes("CONTEXT"));
});

check("RenderStepped in a server Script is an error", () => {
  const answer = [
    "**Server Script — ServerScriptService.Loop**",
    "```lua",
    "local RunService = game:GetService('RunService')",
    "RunService.RenderStepped:Connect(function(dt)",
    "  print(dt)",
    "end)",
    "```"
  ].join("\n");
  assert.ok(codes(verifier.verifyAnswer(answer)).includes("CONTEXT"));
});

check("DataStoreService in a LocalScript is an error", () => {
  const answer = [
    "**LocalScript — StarterPlayerScripts.Save**",
    "```lua",
    "local DataStoreService = game:GetService('DataStoreService')",
    "local store = DataStoreService:GetDataStore('Coins')",
    "print(store)",
    "```"
  ].join("\n");
  assert.ok(codes(verifier.verifyAnswer(answer)).includes("CONTEXT"));
});

/* ------------------------------- Syntax -------------------------------- */

check("missing `end` flagged as a syntax error", () => {
  const answer = [
    "**Server Script — ServerScriptService.Broken**",
    "```lua",
    "local function greet(name)",
    "  print('hi ' .. name)",
    "```"
  ].join("\n");
  const result = verifier.verifyAnswer(answer);
  assert.ok(codes(result).includes("SYNTAX"), JSON.stringify(result.findings));
});

check("while true do without a yield is flagged", () => {
  const answer = [
    "**Server Script — ServerScriptService.Spin**",
    "```lua",
    "while true do",
    "  print('spin')",
    "end",
    "```"
  ].join("\n");
  assert.ok(codes(verifier.verifyAnswer(answer)).includes("INFINITE_LOOP"));
});

/* ------------------------------ Animations ------------------------------ */

check("animation restarted every frame is flagged", () => {
  const answer = [
    "**LocalScript — StarterPlayerScripts.StretchAnim**",
    "```lua",
    "local RunService = game:GetService('RunService')",
    "local track = nil",
    "RunService.RenderStepped:Connect(function()",
    "  track = track or script.Parent.Humanoid:WaitForChild('Animator'):LoadAnimation(script.Animation)",
    "  track:Play()",
    "end)",
    "```"
  ].join("\n");
  assert.ok(codes(verifier.verifyAnswer(answer)).includes("ANIMATION_LOOP"));
});

check("guarded animation playback is NOT flagged", () => {
  const answer = [
    "**LocalScript — StarterPlayerScripts.StretchAnim**",
    "```lua",
    "local RunService = game:GetService('RunService')",
    "local track = nil",
    "local playing = false",
    "RunService.Heartbeat:Connect(function()",
    "  track = track or script.Parent:WaitForChild('Humanoid'):WaitForChild('Animator'):LoadAnimation(script.Animation)",
    "  if not playing then",
    "    playing = true",
    "    track:Play()",
    "  end",
    "end)",
    "```"
  ].join("\n");
  assert.ok(!codes(verifier.verifyAnswer(answer)).includes("ANIMATION_LOOP"));
});

/* ----------------------------- Remotes class ---------------------------- */

check("RemoteFunction used like a RemoteEvent is flagged", () => {
  const answer = [
    "**Server Script — ServerScriptService.Handler**",
    "```lua",
    "local GetCoins = game.ReplicatedStorage:WaitForChild('GetCoinsFunction')",
    "GetCoins.OnServerEvent:Connect(function(player)",
    "  print(player.Name)",
    "end)",
    "```"
  ].join("\n");
  const result = verifier.verifyAnswer(answer);
  assert.ok(codes(result).includes("REMOTE_CLASS"), JSON.stringify(result.findings));
});

/* ------------------------------- Guidance ------------------------------- */

check("missing Explorer placement guidance is flagged for a coding task", () => {
  const answer = "```lua\nprint('hello')\n```";
  const result = verifier.verifyAnswer(answer, { request: "make me a script that prints hello" });
  assert.ok(codes(result).includes("PLACEMENT"));
});

check("plain prose answer produces no findings", () => {
  const result = verifier.verifyAnswer("RemoteEvents send data from the client to the server. Use FireServer on the client and OnServerEvent on the server.", { request: "explain RemoteEvents" });
  assert.deepStrictEqual(result.findings, []);
});

check("client input without validation is flagged", () => {
  const answer = [
    "**Server Script — ServerScriptService.Damage**",
    "```lua",
    "local Remote = game.ReplicatedStorage:WaitForChild('Hit')",
    "Remote.OnServerEvent:Connect(function(player, amount)",
    "  player.Character.Humanoid:TakeDamage(amount)",
    "end)",
    "```"
  ].join("\n");
  assert.ok(codes(verifier.verifyAnswer(answer)).includes("VALIDATION"));
});

check("labeled wrong example is skipped (debugging answers stay intact)", () => {
  const answer = [
    "**Wrong (this is the bug):**",
    "```lua",
    "local Remote = game.ReplicatedStorage:WaitForChild('Ping')",
    "Remote.OnClientEvent:Connect(function() end)",
    "```",
    "**Correct server code:**",
    "```lua",
    "local Remote = game.ReplicatedStorage:WaitForChild('Ping')",
    "Remote.OnServerEvent:Connect(function(player) end)",
    "```"
  ].join("\n");
  const result = verifier.verifyAnswer(answer);
  assert.ok(!codes(result).includes("EVENT_DIRECTION"), "labeled counter-example should not be flagged: " + JSON.stringify(result.findings));
});

check("project-specific answer must admit it cannot see the game", () => {
  const answer = [
    "**LocalScript — StarterPlayerScripts.Stretch**",
    "```lua",
    "local track = script.Parent.Humanoid:WaitForChild('Animator'):LoadAnimation(script.Animation)",
    "track:Play()",
    "```"
  ].join("\n");
  const result = verifier.verifyAnswer(answer, { request: "My animation keeps restarting on my part called CubePosition." });
  assert.ok(codes(result).includes("DISCONNECT_HONESTY"), JSON.stringify(result.findings));
});

check("acknowledging the disconnect satisfies the honesty check", () => {
  const answer = [
    "I can't see your game because Studio is not connected, so I'm assuming `CubePosition` is a physical part.",
    "**LocalScript — StarterPlayerScripts.Stretch**",
    "```lua",
    "local track = script.Parent.Humanoid:WaitForChild('Animator'):LoadAnimation(script.Animation)",
    "track:Play()",
    "```"
  ].join("\n");
  const result = verifier.verifyAnswer(answer, { request: "My animation keeps restarting on my part called CubePosition." });
  assert.ok(!codes(result).includes("DISCONNECT_HONESTY"), JSON.stringify(result.findings));
});

/* ------------------------------- Prompt --------------------------------- */

check("prompt forbids pretending to inspect when Studio is disconnected", () => {
  const sys = prompt.buildSystemPrompt({ persona: {}, studio: null });
  assert.ok(/NOT AVAILABLE/.test(sys));
  assert.ok(/must not pretend/i.test(sys));
  assert.ok(/Never output inspection directives/i.test(sys));
  assert.ok(/FireServer/.test(sys) && /OnServerEvent/.test(sys));
  assert.ok(/MANDATORY VERIFICATION/.test(sys));
});

check("prompt makes the user's requested mode outrank build defaults", () => {
  const sys = prompt.buildSystemPrompt({ persona: {}, studio: null });
  assert.ok(/Mode control/.test(sys));
  assert.ok(/TALK mode/i.test(sys));
  assert.ok(/NO fenced code blocks/i.test(sys));
  assert.ok(/stay in TALK mode/i.test(sys));
  assert.ok(/read-only for the rest of the session/i.test(sys));
  assert.ok(sys.length <= prompt.MAX_PROMPT_CHARS);
});

check("prompt exposes real directives only when connected", () => {
  const connected = prompt.buildSystemPrompt({
    persona: { systemPrompt: "Be concise." },
    studio: { connected: true, kind: "mcp", url: "http://127.0.0.1:9000/mcp", tools: [{ name: "inspect_instance", description: "Inspect an instance" }] }
  });
  assert.ok(/CONNECTED/.test(connected));
  assert.ok(/\[\[NEXORA:inspect/.test(connected));
  assert.ok(/inspect_instance/.test(connected));
  assert.ok(/Be concise/.test(connected));
  assert.ok(connected.length <= prompt.MAX_PROMPT_CHARS);
});

console.log("\n" + passed + " Roblox intelligence tests passed.");
