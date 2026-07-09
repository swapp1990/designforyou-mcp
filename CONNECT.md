# DesignForYou MCP — connect guide

This file is the machine-readable setup guide (no JavaScript).
Human UI: https://designforyou.swapp1990.org/connect
Discovery: https://designforyou.swapp1990.org/.well-known/mcp/server.json

## Server

| Field | Value |
|-------|--------|
| URL | `https://designforyou.swapp1990.org/mcp/v2/` |
| Transport | Streamable HTTP (remote MCP) |
| Trailing slash | **Required** (`/mcp/v2/` not `/mcp/v2`) |
| OAuth scopes | `openid` `profile` `email` |
| Server name | `designforyou` (recommended in client configs) |

## Auth (pick one)

There is **no** free anonymous access for **paid** tools. Read-only catalog tools
may work without auth; generation and other metered tools require a signed-in user.

### A) OAuth (browser sign-in) — primary path

**This is the normal flow.** You sign in once in a browser; the **MCP client**
stores tokens. You do **not** generate a PAT on the website for this path.

1. Add the MCP server URL (recipes below).
2. When the client prompts, complete the **web login** (Google or email/password
   via Supabase). This is a real account sign-in, not a pasted API key.
3. The client stores OAuth access/refresh tokens. Subsequent calls are silent
   until reauthorization is required.

If the client shows the server as **disabled / not connected / auth required**
after add, OAuth did not finish. Use option B only as a fallback.

### B) Long-lived bearer token — optional fallback

**Not the default.** Use only when OAuth cannot complete (Codex bearer-first,
headless agents, CI, or OAuth stuck on “disabled / not connected”).

1. Sign in at https://designforyou.swapp1990.org
2. Open https://designforyou.swapp1990.org/connect
3. Generate a token (shown once). Store it as env var `DESIGNFORYOU_MCP_TOKEN`.
4. Configure the client to send `Authorization: Bearer <token>`.
5. Revoke the token on the same page if it leaks.

Minting **requires** a signed-in website session. Agents cannot mint a token by
calling MCP while unauthenticated. Do **not** paste browser localStorage tokens.
Do **not** use admin or service tokens.

## Client recipes

### Claude Code

**OAuth:**

```bash
claude mcp add --transport http designforyou https://designforyou.swapp1990.org/mcp/v2/
# all projects on this machine:
claude mcp add --scope user --transport http designforyou https://designforyou.swapp1990.org/mcp/v2/
claude mcp login designforyou
```

**Bearer (after minting `DESIGNFORYOU_MCP_TOKEN`):**

```bash
claude mcp add --transport http designforyou https://designforyou.swapp1990.org/mcp/v2/ \
  --header "Authorization: Bearer ${DESIGNFORYOU_MCP_TOKEN}"
```

### Grok (xAI)

**OAuth (interactive):**

```bash
grok mcp add --transport http designforyou https://designforyou.swapp1990.org/mcp/v2/
```

Then in the Grok TUI: `/mcps` → select `designforyou` → press `i` to authorize
→ browser sign-in → press `r` to refresh.

**Bearer (fallback):**

```bash
# PowerShell (Windows)
[Environment]::SetEnvironmentVariable("DESIGNFORYOU_MCP_TOKEN", "<paste-token-here>", "User")

grok mcp add --transport http designforyou https://designforyou.swapp1990.org/mcp/v2/ \
  --header "Authorization: Bearer ${DESIGNFORYOU_MCP_TOKEN}"
grok mcp doctor designforyou
```

### Codex

Bearer-first (mint token first):

```powershell
[Environment]::SetEnvironmentVariable("DESIGNFORYOU_MCP_TOKEN", "<paste-token-here>", "User")
codex mcp remove designforyou
codex mcp add designforyou --url https://designforyou.swapp1990.org/mcp/v2/ --bearer-token-env-var DESIGNFORYOU_MCP_TOKEN
```

### OpenCode

**OAuth:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "designforyou": {
      "type": "remote",
      "url": "https://designforyou.swapp1990.org/mcp/v2/",
      "enabled": true
    }
  }
}
```

```bash
opencode mcp auth designforyou
opencode mcp list
```

**Bearer (fallback):**

```bash
opencode mcp add designforyou --url https://designforyou.swapp1990.org/mcp/v2/ \
  --header "Authorization=Bearer ${DESIGNFORYOU_MCP_TOKEN}"
```

### Cursor / VS Code

One-click from https://designforyou.swapp1990.org/connect, or:

```json
{
  "mcpServers": {
    "designforyou": {
      "url": "https://designforyou.swapp1990.org/mcp/v2/",
      "transport": "http"
    }
  }
}
```

Complete OAuth when the editor prompts.

### Claude Desktop

Add to `claude_desktop_config.json` (native HTTP) or use the npm stdio shim
`npx -y designforyou-mcp`. Restart Claude Desktop, then complete OAuth when
prompted.

## Agent checklist (curl)

```bash
curl -s https://designforyou.swapp1990.org/.well-known/mcp/server.json
curl -s https://designforyou.swapp1990.org/.well-known/mcp/connect.md
curl -s https://designforyou.swapp1990.org/connect.md
curl -s https://designforyou.swapp1990.org/.well-known/oauth-protected-resource

# Unauth control on transport (expect 401)
curl -s -D - -X POST "https://designforyou.swapp1990.org/mcp/v2/" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'

# Smoke initialize with a minted bearer (expect SSE initialize result)
curl -s -X POST "https://designforyou.swapp1990.org/mcp/v2/" \
  -H "Authorization: Bearer $DESIGNFORYOU_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'
```

## After connect

- Prefer free probes first: `browse_templates`, `recommend_template`, `get_credits`.
- Paid tools (`generate`, sprite sheets, video, auditions) debit credits; top up at
  https://designforyou.swapp1990.org/billing
- Full UI + token mint: https://designforyou.swapp1990.org/connect
