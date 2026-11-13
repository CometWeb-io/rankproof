# MCP server for AI agents

`rankproof mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio, so an assistant can check links instead of guessing what a page contains. It is a thin adapter over the same engine and contract as the HTTP API; verified with the official MCP TypeScript SDK client.

## Tools

| Tool               | What it does                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify_links`     | Up to 50 pairs (`pairs` array or CSV `table`), optional agreed anchor/rel/placement and `render`. Returns a text report and `structuredContent` with one verdict per pair, notes, near matches and the SHA-256 of the HTML read. |
| `explain_verdicts` | The exact meaning and limits of `meets`, `deviates`, `missing`, `unverified` and the evidence fields — so a summary for a user does not overstate what was checked.                                                              |

Both tools are read-only (`readOnlyHint`); `verify_links` fetches public pages (`openWorldHint`). Private, loopback and metadata addresses are refused as everywhere else. `render` works only when the server was started with `RANKPROOF_RENDER=1` and Playwright is installed.

## Claude Code

```bash
claude mcp add rankproof -- npx -y rankproof mcp
# from a clone instead of npm:
claude mcp add rankproof -- node /path/to/rankproof/bin/rankproof.mjs mcp
```

## Claude Desktop and other clients

```json
{
  "mcpServers": {
    "rankproof": {
      "command": "npx",
      "args": ["-y", "rankproof", "mcp"],
      "env": { "RANKPROOF_RENDER": "0" }
    }
  }
}
```

Many clients start servers with a minimal environment. If your network needs a proxy (`HTTPS_PROXY`, `NODE_OPTIONS`), or you want rendering, pass those variables in `env`; otherwise every page comes back `unverified` — honestly, but uselessly.

## What an agent should say

The server's `instructions` and `explain_verdicts` tell the model the rules: `unverified` means "could not be checked", never "missing"; `missing` is scoped to the HTML that was fetched (or rendered); a hash shows the stored copy is unchanged, not that every visitor saw the same page. See [evidence](evidence.md).
