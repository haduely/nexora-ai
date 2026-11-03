# Nexora AI — Deployment Guide (Public Online)

Nexora can run locally or as a public HTTPS website. This guide explains honest, verifiable deployment (no invented URLs; you must verify yourself).

## 1. Goals
- Publicly accessible over HTTPS (no localhost dependency for the end user).
- Real AI backend (no fake responses).
- Persistent configuration via environment variables on ephemeral disks.
- Roblox Studio connector stays read-only by default; tool calls locked in public mode unless explicitly authorized.

## 2. Hosting recommendations (2026)

| Host | Free tier | Notes | Verdict |
|---|---|---|---|
| [Render](https://render.com/) | 750 instance-hours/mo, 512MB, spins down after ~15min idle (cold start ~60s), web service free | No card for free web service; easy Git push/deploy; PORT provided. | **Recommended** for backend/API + static UI (single service). |
| [Railway](https://railway.app/) | $5/month credit (trial) then usage-based | Easy, zero-friction, but free credit finite. | Good if Render is constrained. |
| [Koyeb](https://www.koyeb.com/) | Free tier exists with idle scale-to-zero; often requires verification | Solid, can run Docker. | Viable. |
| [Cloudflare Pages](https://pages.cloudflare.com/) | Frontend static only (serverless functions limited CPU/time) | Pairs well if splitting; chat/AI calls can hit timeouts. | Pair with Render backend if desired. |
| [Vercel](https://vercel.com/) | Hobby (serverless) | Function duration limits for longer reasoning calls. | Not ideal for the full Node server. |
| [Fly.io](https://fly.io/) | Paid-focused since Oct 2024 | Avoid for a pure free deploy. | Not recommended. |

Render (single web service) is the simplest path: serves static `public/` + JSON `/api/*` same-origin (no CORS friction), and provides HTTPS at `https://*.onrender.com`.

## 3. Quick deploy (Render, free)

1. **Create a GitHub repository**. You have a clean source (no secrets). Use `nexora-ai` or similar. (No git installed locally — push from your machine using the ZIP or `git`.)
2. **Push code**: extract `nexora-ai-v0.3.0.zip` to a folder, `git init`, commit, push to GitHub.
3. **Create Render Web Service**: [New Web Service](https://dashboard.render.com/create?type=web) → Connect your repo → `nexora-ai`.
4. **Settings**:
   - **Runtime**: Node
   - **Build Command**: (leave empty; no build step required)
   - **Start Command**: `node server/server.js`
   - **Plan**: Free
5. **Environment Variables** (keyless works immediately):
   - `NEXORA_PUBLIC` = `1`
   - `NEXORA_TRUST_PROXY` = `1`
   - `PORT` = `10000` (Render sets PORT but explicit is harmless)
   - (Optional) `NEXORA_PROVIDER` = `pollinations`, `NEXORA_MODEL` = `openai-fast` (default; no key needed)
6. **Deploy** → wait for build/start. Cold start (idle spin-down): first request may take ~60 seconds. That is normal on Render Free.
7. **Verify**: open `https://<your-service>.onrender.com/api/health`. Expect:
   ```json
   {"status":"ok","product":"Nexora AI","version":"0.3.0","stage":2,"stageName":"Roblox Developer Intelligence","publicDeployment":true,"managedPort":true,"uptimeMs":...,"time":"..."}
   ```
8. **UI test**: load `/` in browser. Studio badge shows "Disconnected" (honest). Chat works with Pollinations (1 reply/30s per IP).

> Do not claim the site is deployed until Step 7 returns `status:"ok"` with `publicDeployment:true` from the actual HTTPS URL.

## 4. Using a real provider (env-managed, production-safe)

Cloud deploys have ephemeral disks — config file writes are lost on restart. Use environment variables instead.

| Provider | Vars | Notes |
|---|---|---|
| Pollinations (keyless) | — | Default. No key, free community tier (1 reply/30s/IP). Good for demos. |
| Gemini | `NEXORA_PROVIDER=gemini`, `NEXORA_MODEL=gemini-2.5-flash`, `NEXORA_GEMINI_KEY=AIza...` | Free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Env key is never written to disk. |
| OpenAI-compatible | `NEXORA_PROVIDER=openai`, `NEXORA_MODEL=<model>`, `NEXORA_OPENAI_KEY=sk-...`, `NEXORA_OPENAI_BASE_URL=https://.../v1` (if custom) | Set base URL in the stored config locally, or override in code if needed; env key supported. |

When an env key is present, the Models page marks it as `keySource:"env"` and blocks saving/changing it through the UI (409 `KEY_FROM_ENV`). That is intentional and correct for production.

## 5. Roblox Studio connector (public deployment)

- Local: `studio.mcpUrl` can point to an MCP server on `127.0.0.1`. `GET /api/studio/status` probes live (never fakes). 
- Public: `POST /api/studio/mcp/call` is **locked** by default (`STUDIO_LOCKED`) unless you send the shared header `X-Nexora-Studio-Token: <your-token>` and set `NEXORA_STUDIO_TOKEN=<your-token>` in the environment. Listing tools (`GET /api/studio/mcp/tools`) is allowed in public mode (metadata only), but calling tools is rejected without the token. 
- Principle: the online website must remain independent from your local Studio machine. Do not expose arbitrary tool execution to the internet.

## 6. Security checklist
- Secrets never in git (`config/settings.json`, `.env` ignored). Only `.env.example` committed.
- Env-managed keys stripped from disk writes.
- HSTS added when `PUBLIC_MODE=1` (or behind a trusted proxy).
- Rate limits per IP (X-Forwarded-For respected only when `TRUST_PROXY=1`).
- CSP, X-Content-Type-Options, Referrer-Policy present.
- Static files served only from `public/`; `config/` and `data/` unreachable.
- No public endpoint executes local commands; Studio tool calls gated in public mode.

## 7. Verification (must do before claiming "done")
1. Health: `https://<url>/api/health` → `publicDeployment:true`, `status:"ok"`.
2. Chat: send a simple prompt → real reply appears (no "simulated" text).
3. Studio: Status shows "Disconnected" unless you connect a real MCP/bridge (honest).
4. Disconnected behavior: ask it to "inspect Workspace" while disconnected → must admit it cannot see the game (no fabricated inspection).
5. Tests: locally `node tests/verify.test.js && node tests/modules.test.js && node tests/server.test.js` → 24+10+18 passed (existing). New tests `tests/mcp.stub.test.js`, `tests/production.test.js`, `tests/studio.bridge.test.js` can be run locally.

## 8. Known limitations
- Render Free cold starts after idle (~60s). This is normal.
- Pollinations keyless: 1 reply / 30s per IP (HTTP 402 FREE_LIMIT). The server waits once and retries (pacing), but rapid bursts will be rate-limited.
- MCP client uses JSON-RPC over HTTP (with SSE fallback). Requires a real MCP server to connect; when absent, status is honestly disconnected. Studio's own server is stdio-only, so run `studio/mcp-http-bridge.js` (see STUDIO-CONNECTION.md).
- Saved projects/chats live in `data/nexora-store.json` (env `NEXORA_DATA_DIR` moves it). Render Free has an ephemeral disk: the file survives page reloads but is wiped on every redeploy/restart, so the Projects view labels storage as temporary when `NEXORA_EPHEMERAL_DISK=1`. For durable hosting, mount a paid disk or move the store to Postgres.
- Auto-deploy is not active: the service is linked to the repo, but no GitHub webhook exists (Render's GitHub App is not installed on it), so a push alone does not deploy. Trigger one with `POST /v1/services/srv-dbkmgft9fdbs73boqjvg/deploys`, or install Render's GitHub App on the repo to make pushes deploy.
- Chat runs on Gemini (`gemini-flash-lite-latest`); `gemini-2.5-flash` is retired for new keys, and `gemini-flash-latest` / `gemini-3.x-flash` return 503 "high demand" often enough to be unusable as a default.

## 9. Done definition
Nexora is "done" only when: (a) all available checklist tasks are implemented and verified by actual tests, (b) the website is publicly accessible over HTTPS, and (c) the verified HTTPS URL returns `status:"ok"` with `publicDeployment:true`. If external authorization (GitHub push, hosting account) is required, that is the single remaining blocker — do not fabricate a URL.

Current status (2026-11-04): satisfied. https://nexora-ai-8281.onrender.com
returns `status:"ok"`, `publicDeployment:true`, and answers real chat requests.
