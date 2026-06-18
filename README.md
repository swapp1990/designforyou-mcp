# DesignForYou — MCP server

Generate **logos, social posts, app-store screenshots, comic panels, and
visual-novel assets** from natural-language prompts — directly inside Claude
Code, Cursor, ChatGPT, or any MCP client.

DesignForYou is an MCP-native design generator backed by 119 templates. Browse
and recommend tools are free; generation is metered per user (50 free credits on
sign-up).

- **Website:** https://designforyou.swapp1990.org
- **MCP endpoint (remote, streamable HTTP):** `https://designforyou.swapp1990.org/mcp/v2/`
- **Auth:** OAuth 2.1 + Dynamic Client Registration (sign in with Google or
  email/password). Read-only tools work without auth.
- **Privacy:** https://designforyou.swapp1990.org/privacy

## Install

### Claude Code
```bash
claude mcp add --transport http designforyou https://designforyou.swapp1990.org/mcp/v2/
```
Then run any prompt below; Claude Code opens a browser for sign-in on the first
paid call.

### Cursor
Add to `.cursor/mcp.json` (or **Settings → MCP → Add**):
```json
{
  "mcpServers": {
    "designforyou": {
      "url": "https://designforyou.swapp1990.org/mcp/v2/"
    }
  }
}
```

### Claude Desktop
Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "designforyou": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://designforyou.swapp1990.org/mcp/v2/"]
    }
  }
}
```

### ChatGPT
DesignForYou is being submitted to the ChatGPT app directory. Until then, use the
remote URL above in any MCP-capable client.

## Tools

| Tool | Cost | What it does |
|------|------|--------------|
| `browse_templates` | free | Browse the 119-template catalog (filter by category) |
| `recommend_template` | free | Recommend the best templates for a described use case |
| `get_text_fields` | free | List a template's editable text fields |
| `get_credits` | free | Check your credit balance |
| `generate` | paid | Generate a finished design from a template + description |
| `generate_variations` | paid | Generate style variations of a template |
| `edit_text` | paid | Edit text on an existing design |
| `vn_generate_sprite_sheet` | paid | Generate a visual-novel character sprite sheet |

## Example prompts

- *"Browse logo templates on DesignForYou."*
- *"I'm opening a coffee shop called NEXUS — minimalist, warm earth tones. Make me a logo."*
- *"Generate an Instagram post announcing a 20%-off flash sale for a vegan bakery."*
- *"Create an app-store screenshot for a meditation app, calm gradient background."*

## How it works

DesignForYou exposes a remote MCP server. On the first paid tool call, your MCP
client discovers the OAuth flow (RFC 9728 protected-resource metadata →
Supabase OAuth server with Dynamic Client Registration), opens a browser for
sign-in + consent, and then calls tools with your token. Generation is metered
against your credit balance; you buy more on the website (never in-chat).

This repository is the public home for install docs and the MCP `server.json`.
The product itself is a hosted service — there is no self-host package.

## Links
- App: https://designforyou.swapp1990.org
- MCP docs: https://designforyou.swapp1990.org/docs/mcp
- Listed on the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=designforyou) as `org.swapp1990.designforyou/designforyou`.
