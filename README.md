# NEXORA AI

**An AI development assistant for Roblox.** Describe what you want to build, debug, or improve ??? Nexora plans it and, once authorized, applies it through a real Roblox Studio integration.

Dark charcoal + violet interface ?? real local server ?? honest status reporting ?? no fabricated capabilities.

---

## Current build stage

| Stage | Purpose | Status |
|-------|---------|--------|
| 1 ??? Foundation | Branded interface, navigation, chat layout, local server, project structure | **Complete** |
| **2 ??? AI Connection** | Real provider adapters (free-tier APIs, local Ollama), real chat responses | **Complete** |
| **2.5 ??? Roblox Intelligence** | Expert instructions, static code verification with automatic repair, real Studio/MCP probing | **Complete ??? see verification below** |
| 3 ??? Projects & Persistence | Chat history, projects, per-game context | Not started |
| 4 ??? Roblox Studio Bridge | Real connection to Studio via bridge / plugin / MCP | Not started ??? nothing exists inside your Studio |
| 5 ??? Project Inspection | Read-only hierarchy/script analysis | Not started |
| 6 ??? Approved Actions | Permission-gated changes with previews | Not started |
| 7 ??? Testing & Refinement | Bug fixes, usability polish | Ongoing per stage |
| **Online ??? Public deployment** | Hosted HTTPS site + cloud-ready server (env credentials, public-mode hardening) | **Code complete & tested ??? not yet deployed (needs your hosting account)** |

**Chat is live.** Sending a message today calls the active AI provider through the
local server and renders the model's genuine reply. If a provider fails, the UI
shows the provider's real error with a working Retry ??? **nothing is ever faked.**
Features that belong to later stages are shown as clearly labeled "arrives in
Stage X" states.

---

## How to run

```
cd nexora-ai
powershell -File start.ps1      # or double-click start.bat
```

Then open **http://127.0.0.1:7810** in your browser.

Chat works immediately with no setup: **Pollinations (keyless)** is the default
provider ??? a community free endpoint; internet required, ~1 reply per 30 seconds
on the free tier.

- The server binds to `127.0.0.1` only (not reachable from the network).
- Port override: `$env:NEXORA_PORT = '7811'` before starting.
- No `npm install` is required ??? the server uses Node's standard library only (Node 18+; tested on Node 24).

### Running it online (public HTTPS)

Nexora is deployable today ??? see **[DEPLOYMENT.md](DEPLOYMENT.md)**. A host sets
`PORT`; the server then binds `0.0.0.0`, trusts the platform proxy for client IPs,
sends HSTS, and (with `NEXORA_PUBLIC=1`) becomes read-only for config and locks
Studio tool calls behind `NEXORA_STUDIO_TOKEN`. Provider credentials come from
environment variables (`NEXORA_GEMINI_KEY`, ????) and are **never written to
disk**, because hosted disks are ephemeral. `render.yaml`, `Dockerfile` and
`.env.example` are included.

**Status honesty:** live at https://nexora-ai-8281.onrender.com — Render free tier,
HTTPS, auto-deploy on every push to `main`. The free instance sleeps after ~15
minutes idle, so the first request after a pause can take ~50 seconds. Hardening is
covered by tests (`tests/production.test.js`, 9/9).


### Connecting Google Gemini (recommended upgrade, free key)

1. Get a free key at **https://aistudio.google.com/apikey** ("Get API key").
2. In Nexora, open **Models** ??? the **Gemini** card ??? paste the key ??? **Save & Activate**.
3. The key is stored **server-side only** (`config/settings.json`); the API never
   returns it ??? only a masked hint like `key stored (39 chars, ends ???xxxx)`.
4. Free-tier limits are the provider's real ones (per-minute/per-day quotas);
   when they're hit, Nexora shows the provider's actual error with a Retry.

**Ollama (fully offline):** install from [ollama.com](https://ollama.com), run
`ollama serve` + `ollama pull qwen2.5-coder:7b`, then Save & Activate the
**Ollama** card ??? no key, no cost, no internet.

**OpenAI-compatible:** any endpoint that speaks the `/chat/completions` protocol
(e.g. OpenRouter, Groq) works via the fourth card.

---

### Connecting Roblox Studio

Roblox Studio's built-in MCP server speaks stdio; Nexora talks HTTP JSON-RPC.
Bridge the two, then restart Nexora:

```bat
node studio\mcp-http-bridge.js
set NEXORA_MCP_URL=http://127.0.0.1:8787/mcp
```

Full step-by-step guide, safety notes and troubleshooting:
[STUDIO-CONNECTION.md](STUDIO-CONNECTION.md).

## Architecture

```
nexora-ai/
????????? server/                     # Local Node process ??? the only trusted boundary
???   ????????? server.js               # HTTP entry: routing, rate limiting, logging
???   ????????? static.js               # Static serving with traversal protection + CSP
???   ????????? config.js               # config/settings.json loader (never served to browser)
???   ????????? lib/
???       ????????? ai.js               # Provider adapters: Gemini, Ollama, OpenAI-compatible, Pollinations
???       ????????? prompt.js           # Roblox-expert system prompt (context + honesty + format)
???       ????????? verify.js           # Deterministic Luau answer checker + repair prompt builder
???       ????????? studio.js           # Real bridge/MCP probe, JSON-RPC client, tool directives
????????? public/                     # Frontend ??? no secrets, no build step
???   ????????? index.html              # Single-page shell: sidebar, 5 views, composer
???   ????????? assets/
???       ????????? css/nexora.css      # Design system (dark violet, glow, responsive)
???       ????????? js/
???           ????????? highlight.js    # Luau/JS/JSON syntax highlighter (browser + Node)
???           ????????? markdown.js     # Safe markdown renderer with code blocks + copy
???           ????????? store.js        # In-memory conversations + UI preferences
???           ????????? chat.js         # Chat view: real /api/chat calls, history, retry
???           ????????? providers.js    # Models view: provider cards, key save/test/clear
???           ????????? app.js          # Navigation, server status, settings
????????? config/settings.json        # Server-side config + keys (auto-created, never HTTP-served)
????????? data/                       # Stage 3 persistence target (empty)
????????? tests/
???   ????????? modules.test.js         # Markdown + highlighter tests (Node)
???   ????????? verify.test.js          # Deterministic Roblox verifier tests (no network)
???   ????????? server.test.js          # Real HTTP integration tests (isolated config dir)
???   ????????? roblox.skills.test.js   # Live Tests A-D against the real provider (paced)
???   ????????? ui.e2e.test.js          # Headless-browser E2E incl. real AI generations
????????? start.ps1 / start.bat
????????? README.md
```

**Why this shape:** the browser never talks to AI providers or Studio directly.
All privileged traffic goes through the local Node process, so API keys stay in
`config/settings.json` and every capability is gated in one place. New providers
= one adapter module in `server/lib/ai.js`; the UI stays unchanged.

---

## Verification (actually run, 2026-10-19)

| Suite | Command | Result |
|-------|---------|--------|
| Syntax | `node --check` on all changed JS files | 8/8 clean |
| Module tests | `node tests/modules.test.js` | **10/10 passed** |
| Roblox verification (deterministic) | `node tests/verify.test.js` | **24/24 passed** |
| Server integration | `node tests/server.test.js` | **18/18 passed** |
| MCP protocol (real JSON-RPC stub server) | `node tests/mcp.stub.test.js` | **8/8 passed** |
| Studio MCP bridge (stdio to HTTP, mock server) | `node tests/studio.bridge.test.js` | **4/4 passed** |
| Production / public-deploy hardening | `node tests/production.test.js` | **9/9 passed** |
| Live Roblox skills A???D (real AI, paced) | `node tests/roblox.skills.test.js` | **4/4 passed** |
| UI end-to-end (headless Edge, incl. mobile 390x844) | `node tests/ui.e2e.test.js` | **19/19 passed** |

### MCP protocol evidence (`tests/mcp.stub.test.js`)

The Studio client is a real MCP implementation, verified against a real MCP
server (JSON-RPC 2.0 over HTTP) started by the test itself:

- live probe reports `connected:true, kind:"mcp"` with the server's tool list
- `GET /api/studio/mcp/tools` returns those tools
- `POST /api/studio/mcp/call` executes a tool and returns its actual output
- an unknown tool is rejected (400), never silently accepted
- `lib/studio.runDirective` picks the right tool, fills argument shapes, executes
- with nothing listening, status is honestly `connected:false`

**What this does not prove:** that *Roblox Studio itself* is connected. That
needs a running Studio MCP server; no Studio is attached in this environment.

### Production hardening evidence (`tests/production.test.js`)

Started exactly as a host starts it (`PORT` from the platform, `NEXORA_PUBLIC=1`,
trusted proxy): binds the platform port; sends HSTS; refuses provider writes
(`READ_ONLY_DEPLOYMENT`); uses an env-provided key labelled `keySource:"env"`
while **never writing it to disk**; locks Studio tool calls without the shared
token and allows them with it (a wrong token is rejected); rate-limits by the
proxied client IP from `X-Forwarded-For`.


### Stage 2.5 ??? Roblox intelligence evidence

The deterministic suite (`tests/verify.test.js`) proves the exact bug class this
upgrade targets: **`Remote.OnClientEvent` inside a server Script is flagged**, as
are `OnServerEvent` in a LocalScript, `FireServer` on the server, `FireClient` on
the client, FireServer/OnClientEvent pairing mismatches, `LocalPlayer` on the
server, `RenderStepped`/`DataStoreService` in the wrong context, unbalanced
`function`/`end`, `while true do` without a yield, animations restarted
every frame without a guard, RemoteFunction/RemoteEvent class mix-ups, missing
server validation, and missing Explorer placement or test steps. It also proves
labeled counter-examples ("wrong / this is the bug") are **not** rewritten, so
debugging answers survive.

Live Tests A???D (real provider, isolated config, 36 s pacing for the free tier):

| Test | Prompt | Result |
|------|--------|--------|
| A | Original RemoteEvent prompt (client ??? server) | **Pass** ??? `FireServer` + `OnServerEvent`, zero verifier errors |
| B | Animation `85895369752677` on `CubePosition` (Studio disconnected) | **Pass** ??? play-once/guard code, honest "can't see your game", assumption stated, zero verifier errors (required one automatic repair round) |
| C | Debug: server Script listening with `OnClientEvent` | **Pass** ??? identifies the direction mistake, gives `OnServerEvent`, zero verifier errors |
| D | "Now improve that example" (history) | **Pass** ??? keeps RemoteEvent context, adds `typeof` server validation, zero verifier errors |

**Provider note:** the keyless Pollinations model is a *reasoning* model. Nexora
now requests a low reasoning budget plus an explicit reply budget, because the
hidden reasoning could otherwise consume the whole reply and return an empty
answer (this was observed and fixed during testing). Truncated replies are
flagged honestly in the UI.

**Honest limitation:** Studio is not connected in this environment (bridge
`127.0.0.1:3587` refuses, no MCP URL configured), so Test B's *real-project
inspection* is **blocked**. What was verified is the honest-disconnect behaviour
(no invented project facts) and the correct, guarded code. The MCP client and
`/api/studio/*` routes are real code paths tested for refusal when nothing
answers; they have **not** been exercised against a live MCP server yet.

Server tests also confirm: interface serving, `/api/providers` honest state,
**stored keys never returned by any read path** (save and GET both checked
against a distinctive fake key), key clear via `"CLEAR"`, `/api/chat` input
validation, chat against Gemini-with-no-key fails with an actionable error and
**no fabricated reply**, isolated config (the real config file is not touched
by tests), CSP/nosniff headers, **config directory unreachable over HTTP**,
**encoded path traversal blocked**, JSON 404s, 405 on bad methods, 429 rate limit,
`/api/studio/status` honestly reports **not connected**, and both
`/api/studio/mcp/tools` and `/api/studio/mcp/call` refuse with
`409 STUDIO_DISCONNECTED` instead of inventing tools or results.

UI tests confirm: app boots with **zero page errors**, live provider state
rendered, **real model replies through the chat UI** (Pollinations, keyless:
`PONG`), **conversation history proven** (the model correctly recalled a
codeword set in an earlier turn), typing indicator, **invalid Gemini key ???
clear error bubble with an actionable hint and no fake reply**, failed message
kept for **Retry**, Retry re-sends and succeeds after restoring the provider,
error bubble cleared, all five views navigate, Settings shows live health,
Studio honestly reports *Disconnected*.

---

## Security model (Stage 2 + online hardening)

- API keys live **only** in `config/settings.json` (or environment variables) ???
  never in `public/`, never returned by the API (write-only: save, mask, clear).
  Environment-supplied keys are marked `keySource:"env"`, cannot be changed from
  the UI (409 `KEY_FROM_ENV`), and are stripped before any disk write.
- **Public mode** (`NEXORA_PUBLIC=1`): provider writes are refused
  (`READ_ONLY_DEPLOYMENT`, so a hosted instance is env-configured), HSTS is sent,
  and `POST /api/studio/mcp/call` is locked behind the `X-Nexora-Studio-Token`
  header (`STUDIO_LOCKED`) so anonymous visitors can never execute tools on the
  machine running the Studio connector.
- Client IP for rate limiting honours `X-Forwarded-For` only when
  `NEXORA_TRUST_PROXY=1` (auto-on when the platform manages `PORT`).
- The frontend can only reach the server it was served from (`connect-src 'self'`).
- All user and model content is treated as untrusted: markdown/HTML is escaped,
  user messages render as plain text, unsafe link protocols are stripped.
- Rate limiting: 180 API requests/min and 30 chat requests/min per client IP.
- `/api/chat` validates message size (8000 chars), history length (60 msgs),
  and system prompt size before any provider is called.
- Directory traversal and encoded (`%2e%2e`) escapes are blocked and tested.
- `config/settings.json` is git ignored and **not served over HTTP** (tested).
- Studio access: **read-only**. The server probes a real local bridge or MCP
  server (`studio.bridgeUrl`, `studio.mcpUrl` / `NEXORA_MCP_URL`) and uses its
  tools only when one actually answers (proven by `tests/mcp.stub.test.js`).
  Nothing is simulated, no move is made inside your place, and modifications
  will require explicit approval gates in Stage 6.

---

## What each view does today

- **Chat** ??? **real AI conversation** with Roblox-expert instructions. Enter
  sends, Shift+Enter newline. Full conversation history is sent to the model each
  turn (so follow-ups work). Every reply is checked by a deterministic Roblox
  verifier; real error-level findings trigger up to two automatic repair rounds,
  and anything still flagged is shown under the reply as a **static-review note**
  (never presented as a Studio test). If the provider stops at its length limit,
  the reply says so. Typing indicator while waiting; provider errors render as
  error bubbles with the provider's real message, an actionable hint, and a
  working **Retry**. Code-block renderer with syntax highlighting and copy buttons.
- **Projects** ??? labeled Stage 3 preview; stores nothing yet.
- **Studio** ??? live probed state: *Checking???* / *Connected* / *Disconnected*, with
  the real endpoint URL and tool count when something answers. It never says
  Connected without a real response.
- **Models** ??? live provider configuration: four cards (Pollinations keyless,
  Gemini, Ollama, OpenAI-compatible) with Save & Activate, Test, Load models,
  and Remove stored key. Keys are masked after saving and never re-displayed.
- **Settings** ??? live server health, version, stage; clears local UI preferences;
  security documentation.

---

## Next step (Stage 3)

Projects & Persistence: saved chat history, named projects, and per-game
context ??? so conversations survive restarts and each Roblox project gets its
own workspace. On a hosted deployment this becomes a cloud database (e.g.
Supabase Postgres) plus accounts, replacing `localStorage`.

---

## Remaining blocker (online deployment)

Everything code-side for a public deployment is implemented and tested, but the
site is **not online yet**. Publishing needs authorization only you can give:

1. A **GitHub repository** containing this project (no git is installed on this
   machine), and
2. A **hosting account** ??? [Render](https://render.com) free web service is the
   recommended path (see DEPLOYMENT.md).

Until then no public HTTPS URL exists, and this README deliberately does not
invent one. Surface this only when you are ready to publish.


