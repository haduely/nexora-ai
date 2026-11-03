# Connecting Nexora AI to Roblox Studio

This guide gets Nexora from "Disconnected" to reading your **real** project:
instance names, properties, script sources, and hierarchy.

Two facts decide the whole setup:

1. **Roblox Studio's built-in MCP server speaks stdio, not HTTP.** Studio ships
   `%LOCALAPPDATA%\Roblox\mcp.bat` (macOS:
   `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`).
2. **Nexora talks MCP over HTTP JSON-RPC** (`server/lib/studio.js`).

So you need a bridge in between. This repo includes one:
`studio/mcp-http-bridge.js`. It starts Studio's stdio server and exposes it at
`http://127.0.0.1:8787/mcp`.

Time: about 5 minutes. No extra npm packages.

---

## 1. Enable the MCP server in Studio

1. Open Roblox Studio with the place you want Nexora to see (update Studio first).
2. Open **Assistant** (top right).
3. Click **…** → **Manage MCP Servers**.
4. Turn on **Enable Studio as MCP server**.

Leave that panel open — the green indicator there shows connected clients, and
it is the fastest way to confirm the bridge works.

> Studio's MCP server can read and modify open places. Only connect tools you
> trust. Nexora itself never writes without your explicit approval.

---

## 2. Start the bridge

In a terminal, from the project folder:

```bat
node studio\mcp-http-bridge.js
```

Expected output:

```
[bridge] listening on http://127.0.0.1:8787/mcp
[bridge] studio command: cmd.exe C:\Users\<you>\AppData\Local\Roblox\mcp.bat
```

Check it independently, in another terminal:

```bat
curl http://127.0.0.1:8787
```

You should get JSON with `"ok": true`.

Optional settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_PORT` | `8787` | HTTP port |
| `BRIDGE_TOKEN` | unset | Require `Authorization: Bearer <token>` |
| `NEXORA_MCP_COMMAND` | Studio's `mcp.bat` / `StudioMCP` | Executable to run instead |
| `NEXORA_MCP_ARGS` | unset | JSON array of arguments for that executable |
| `BRIDGE_TIMEOUT_MS` | `30000` | Per-call timeout |

---

## 3. Point Nexora at the bridge

Nexora reads the endpoint from configuration, never from the browser.

**Option A — environment variable (recommended):**

```bat
set NEXORA_MCP_URL=http://127.0.0.1:8787/mcp
start.bat
```

PowerShell:

```powershell
$env:NEXORA_MCP_URL = "http://127.0.0.1:8787/mcp"
.\start.ps1
```

**Option B — config file:** set it in `config/settings.json`:

```json
{
  "studio": {
    "bridgeUrl": "http://127.0.0.1:3587",
    "mcpUrl": "http://127.0.0.1:8787/mcp"
  }
}
```

Restart Nexora after either change.

---

## 4. Verify the connection

1. Open Nexora → **Studio** tab. It should read **Connected** and list the
   available tools.
2. Or check the API directly:

```bat
curl http://127.0.0.1:7810/api/studio/status
```

Look for `"connected": true`, `"kind": "mcp"`, and a non-zero tool count.

3. Ask a **read-only** question first:

> Using the Studio tools, list what is inside Workspace. Do not change anything.

On a fresh Baseplate the answer should name `Camera`, `Terrain`, `Baseplate`,
and `SpawnLocation`. If it does, the whole chain — Studio → bridge → Nexora →
model — is working.

---

## 5. What Nexora can and cannot do

- **Can:** inspect instances, read script sources, list hierarchies, describe
  properties, and explain errors using your real names and values.
- **Cannot:** edit your project on its own. Changes are proposals until you
  approve them; nothing is applied silently.
- **Won't:** claim it inspected anything when the connection is down — the
  status is a live probe, not a cached guess.

Say *"don't change anything in Studio"* at any time and Nexora stays in
talk-only mode for the rest of the session.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Studio tab shows **Disconnected** | Bridge not running, or `NEXORA_MCP_URL` not set | Start the bridge, restart Nexora, re-check `/api/studio/status` |
| Bridge prints `Studio MCP process exited` | Studio closed, outdated, or MCP server off | Open the place, enable **Enable Studio as MCP server**, restart the bridge |
| `cannot start Studio MCP` | `mcp.bat` missing (old Studio) | Update Roblox Studio, then restart the bridge |
| Chat answers generically | Connected but tool names don't match | Check the tool list on the Studio tab; Nexora only uses tools it can see |
| Green indicator in Studio stays 0 | Bridge started but never handshook | Ask one read-only question in chat to trigger the handshake |
| Works locally, not on the hosted site | Cloud servers cannot reach `127.0.0.1` | See "Hosted deployments" below |

---

## Hosted deployments (nexora-ai-8281.onrender.com)

A Render instance runs on the internet and **cannot reach your PC's
`127.0.0.1`**. Connecting a hosted Nexora to a local Studio requires tunnelling
your machine to the internet, which means:

- anyone who finds that tunnel can query your open Studio place;
- the connection is server-wide, not per visitor, so it must never be enabled
  on a public, shared instance.

Therefore the public demo stays **Disconnected** by design. Use **local mode**
(sections 1–4) for a real Studio connection — it is private, needs no tunnel,
and is faster.

If you genuinely need a hosted connection for personal use: run the bridge with
`BRIDGE_TOKEN`, tunnel only that port with an authenticated tunnel, and set
`NEXORA_MCP_URL` to the tunnel URL on a **private** instance of your own.
