# MijiaFlow / 米家流

[简体中文](README.zh-CN.md) | English

MijiaFlow is an unofficial, local-first **MCP server** for inspecting and
operating Mijia Central Hub "Geek Edition" automations on a trusted local
network. It works with any MCP client — Claude Desktop, Claude Code, Cursor,
Cline, Windsurf, VS Code, Codex CLI, Gemini CLI, and others.

- **Audited reads:** automations, devices, variables, logs, and backup records
  through allowlisted gateway calls only.
- **Guarded writes:** every non-backup mutation requires a plan, a verified
  backup, a baseline recheck, an exact one-time user confirmation, a readback
  verification, and a retained rollback path.
- **Verified backups:** local backup export with digest verification, plus an
  optional cloud backup that is created, polled, downloaded, and verified.
- **Loopback pairing and workbench:** the gateway passcode is entered only on a
  one-time `127.0.0.1` page, which then stays open as a read-only progress
  workbench. The passcode never appears in chat, tool arguments, or logs.

MijiaFlow does not copy Xiaomi frontend code and does not use the restricted
Xiaomi Home Assistant cloud interface. It talks directly to a reachable Mijia
Central Hub on the LAN.

> **Unofficial project:** MijiaFlow is not affiliated with, authorized by, or
> supported by Xiaomi, Mijia, or Xiaomi Home. Product names are used only to
> describe interoperability.

## Compatibility

The supported write pair is Mijia Geek Edition frontend `v1.6.1` with protocol
header `2.0.0`. That exact pair supports the audited read path and guarded
write path. Any other or unknown combination is **read-only**: MijiaFlow
refuses mutation instead of assuming wire or object compatibility.

Read-only mode can still export a verified local backup. It cannot request a
cloud backup because that request writes gateway state.

See [the compatibility matrix](docs/compatibility.md) before connecting a
different gateway release.

## Requirements

- An MCP client (stdio transport)
- Node.js 22 or newer (`npx` ships with npm)
- Network access to the Mijia Central Hub's private/LAN address
- The gateway passcode for the interactive, loopback-only pairing step

## Install

MijiaFlow is published on npm as [`mijiaflow`](https://www.npmjs.com/package/mijiaflow).
Most clients use the same configuration block:

```json
{
  "mcpServers": {
    "mijiaflow": {
      "command": "npx",
      "args": ["-y", "mijiaflow"]
    }
  }
}
```

Where to put it:

- **Claude Desktop:** `claude_desktop_config.json`
  (Windows `%APPDATA%\Claude\`, macOS `~/Library/Application Support/Claude/`).
- **Claude Code:** `claude mcp add mijiaflow -- npx -y mijiaflow`
- **Cursor:** `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`
  globally.
- **Cline:** the MCP servers settings file uses the same `mcpServers` block.
- **Windsurf:** `~/.codeium/windsurf/mcp_config.json`.
- **Gemini CLI:** `~/.gemini/settings.json`.
- **VS Code:** `.vscode/mcp.json`, wrapped as
  `{ "servers": { "mijiaflow": { "command": "npx", "args": ["-y", "mijiaflow"] } } }`.
- **Codex CLI:** `~/.codex/config.toml`:

```toml
[mcp_servers.mijiaflow]
command = "npx"
args = ["-y", "mijiaflow"]
```

On Windows, if a client cannot spawn `npx` directly, use
`"command": "cmd", "args": ["/c", "npx", "-y", "mijiaflow"]`.

To run from a clone instead of npm, build once and point the client at the
bundle: `"command": "node", "args": ["<checkout>/mcp/dist/server.js"]`.

## Start Safely

1. Ask the assistant to probe the gateway URL with `mijia_probe`.
2. Confirm that the reported frontend and protocol versions are recognized.
3. Start a pending session with `mijia_begin_session` and open its one-time
   loopback URL. No gateway WebSocket is open yet.
4. Enter the six-digit gateway passcode on the local MijiaFlow keypad.
   Submitting it opens the WebSocket and starts authentication.
5. Keep the page open: it becomes a read-only workbench that shows session and
   operation progress for the rest of the session. The assistant polls
   `mijia_session_status` until the session is `ready`.
6. Use `mijia_read` to inspect the current state before planning any change.
7. End the session with `mijia_end_session` when finished.

Example requests (replace `GATEWAY_IP` with your gateway's LAN address):

```text
Use MijiaFlow to probe http://GATEWAY_IP/ and list its automations read-only.

Create a verified local backup of my Mijia gateway.

Plan an enable/disable change for automation <id>, show the exact diff, and wait
for my confirmation.
```

## Write Protection

MijiaFlow never turns a natural-language guess directly into a local API write.
The API path only accepts a complete raw graph containing `{ id, nodes, cfg }`.

Every non-backup mutation follows the guarded transaction enforced by the MCP
server:

1. Read and hash the object baseline.
2. Export a backup and verify its digest.
3. Re-read the baseline to detect concurrent changes.
4. Present a diff and require the exact one-time confirmation phrase.
5. Apply the single reviewed operation.
6. Read back and verify the result.
7. Preserve rollback data and restore the object if verification fails.

Backup creation has its own dedicated tool and does not expose a generic RPC
escape hatch. MijiaFlow intentionally provides no `callAPI` tool. See
[the write transaction guide](docs/write-transaction.md).

## Tools

| Tool | Purpose |
| --- | --- |
| `mijia_probe(baseUrl)` | Detect frontend/protocol versions and safe capabilities. |
| `mijia_begin_session(baseUrl)` | Create a pending in-memory session and a one-time six-digit pairing page; the WebSocket opens on submission. |
| `mijia_end_session()` | Close the connection and erase authentication material. |
| `mijia_session_status()` | Report whether the session is absent, awaiting the passcode, authenticating, ready, or failed. |
| `mijia_workbench_status()` | Read the redacted session and recent-operation snapshot shown by the loopback workbench. |
| `mijia_read(resource, filters)` | Read automations, devices, variables, logs, or backups. |
| `mijia_plan_change(operation, payload)` | Produce a baseline-bound diff and one-time confirmation phrase. |
| `mijia_create_backup(fileName, outputDir?, cloud)` | Create and verify a local backup (default directory `~/.mijiaflow/backups`); optionally create, poll, locate, download, and verify a gateway cloud backup. |
| `mijia_apply_change(planToken, backupReceipt, confirmation)` | Recheck, apply, and verify an allowlisted planned mutation. |
| `mijia_rollback(changeId, confirmation)` | Restore the saved object baseline and verify restoration. |

Status tools return machine-readable `structuredContent`, and errors carry a
stable `error` code plus an actionable `hint`.

## Prompts And Resources

The server ships MCP-native guidance, so any client can discover the safe
workflows without external documentation:

- **Prompts:** `mijia_audit` (read-only audit), `mijia_guarded_change` (full
  guarded write), and `mijia_backup` (verified backup).
- **Resources:** `mijiaflow://guide/tool-workflows`,
  `mijiaflow://guide/write-transaction`, `mijiaflow://guide/browser-workflow`,
  and `mijiaflow://guide/security`.
- **Instructions:** the server's `initialize` result summarizes the whole
  probe → pair → read → plan → backup → confirm → apply → rollback flow.

See [API reference](docs/api-reference.md), [protocol notes](docs/protocol.md),
[research basis](docs/research.md), [security model](docs/security.md), and
[troubleshooting](docs/troubleshooting.md).

## Development

```powershell
npm ci
npm run verify   # typecheck + build + test
```

Tests use a local fake gateway for protocol, JSON-RPC, timeout, validation,
backup, concurrent-change, and rollback behavior, plus a stdio smoke test that
boots the committed bundle. Real gateway mutation is not part of the normal
test suite. `mcp/dist/server.js` is a committed build artifact; rebuild it with
`npm run build` whenever `mcp/src` changes.

## License

[MIT](LICENSE)
