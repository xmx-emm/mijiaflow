# MijiaFlow / 米家流

[简体中文](README.zh-CN.md) | English

MijiaFlow is an unofficial, local-first Codex plugin and Skill for inspecting and
operating Mijia Central Hub "Geek Edition" automations on a trusted local
network. It combines two deliberately separate control paths:

- **Browser path:** use the Mijia web UI through semantic labels to view, create,
  and edit automation graphs.
- **Local API path:** audit automations, devices, variables, logs, and backups;
  enable or disable existing graphs; manage variables; create backups; and
  import or export complete raw graphs.

MijiaFlow does not copy Xiaomi frontend code and does not use the restricted
Xiaomi Home Assistant cloud interface. It talks directly to a reachable Mijia
Central Hub on the LAN.

> **Unofficial project:** MijiaFlow is not affiliated with, authorized by, or
> supported by Xiaomi, Mijia, or Xiaomi Home. Product names are used only to
> describe interoperability.

## Compatibility

The first release targets Mijia Geek Edition frontend `v1.6.1` with protocol
header `2.0.0`. That exact pair supports the audited read path and guarded write
path. An unknown or incomplete version match is **read-only**: MijiaFlow refuses
mutation instead of assuming wire or object compatibility.

Read-only mode can export a verified local backup. It cannot request a cloud
backup because that request writes gateway state.

See [the compatibility matrix](docs/compatibility.md) before connecting a
different gateway release.

## Requirements

- Codex Desktop or Codex CLI with plugin and MCP support
- Node.js 22 or newer
- Network access to the Mijia Central Hub's private/LAN address
- The gateway passcode for an interactive, loopback-only pairing step

The MCP server is local. The passcode is entered with the branded
**MijiaFlow / 米家流** six-digit keypad on a one-time page bound to `127.0.0.1`.
The gateway WebSocket opens only after that form is submitted. The same
token-bound loopback page then becomes a persistent, read-only workbench for
the life of the session. It shows connection state and redacted operation
progress while MCP remains the only write path. The passcode is retained only
for the authentication handshake and is never accepted as a tool argument,
written to configuration, or included in logs.

## Install

Clone the plugin into your personal plugin directory and build it:

```powershell
git clone https://github.com/xmx-emm/mijiaflow.git "$HOME/plugins/mijiaflow"
Set-Location "$HOME/plugins/mijiaflow"
npm ci
npm run typecheck
npm test
npm run build
```

Register the local folder in the personal marketplace at
`~/.agents/plugins/marketplace.json`. Its entry uses the local source
`./plugins/mijiaflow`, installation policy `AVAILABLE`, authentication policy
`ON_INSTALL`, and category `Productivity`. Then install it from that marketplace:

```powershell
codex plugin add mijiaflow@personal
```

Restart Codex or open a new task after installation so the Skill and MCP tools
are discovered. If the personal marketplace has a different `name`, substitute
that name for `personal`.

## Start Safely

1. Ask Codex to probe the gateway URL with `mijia_probe`.
2. Confirm that the reported frontend and protocol versions are recognized.
3. Start a pending session with `mijia_begin_session` and open its one-time
   loopback URL. No gateway WebSocket is open yet.
4. Enter the six-digit gateway passcode on the local MijiaFlow keypad. Submitting
   it opens the WebSocket and starts authentication.
5. Keep the loopback workbench open to watch progress; poll
   `mijia_session_status` until the session reports `ready` when Codex needs a
   machine-readable status.
6. Use `mijia_read` to inspect the current state before planning any change.
7. End the session with `mijia_end_session` when finished.

Example requests:

Replace `GATEWAY_IP` with the LAN address of the gateway being controlled.

```text
Use MijiaFlow to probe http://GATEWAY_IP/ and list its automations read-only.

Open the Mijia Geek Edition page and show me the graph that controls the hallway
light. Do not change it.

Plan an enable/disable change for automation <id>, show the exact diff, and wait
for my confirmation.
```

## Write Protection

MijiaFlow never turns a natural-language guess directly into a local API write.
Natural-language graph composition happens in the browser UI. The API path only
accepts a complete raw graph containing `{ id, nodes, cfg }`.

Every non-backup mutation follows the guarded transaction. The MCP server
enforces it for API writes, and the Skill requires the equivalent sequence
before a native browser save:

1. Read and hash the object baseline.
2. Export a backup and verify its digest.
3. Re-read the baseline to detect concurrent changes.
4. Present a diff and require the exact one-time confirmation phrase.
5. Apply the single reviewed operation through the selected path.
6. Read back and verify the result.
7. Preserve rollback data and restore the object if verification fails.

Backup creation has its own dedicated tool and does not expose a generic RPC
escape hatch. A cloud backup is created, polled to completion, awaited in the
eventually consistent backup list, downloaded, and verified. MijiaFlow
intentionally provides no `callAPI` tool.

## Public Tools

| Tool | Purpose |
| --- | --- |
| `mijia_probe(baseUrl)` | Detect frontend/protocol versions and safe capabilities. |
| `mijia_begin_session(baseUrl)` | Create a pending in-memory session and a one-time six-digit pairing page; the WebSocket opens on submission. |
| `mijia_end_session()` | Close the connection and erase authentication material. |
| `mijia_session_status()` | Report whether the session is absent, awaiting the passcode, authenticating, ready, or failed. |
| `mijia_workbench_status()` | Read the redacted session and recent-operation snapshot shown by the loopback workbench. |
| `mijia_read(resource, filters)` | Read automations, devices, variables, logs, or backups. |
| `mijia_plan_change(operation, payload)` | Produce a baseline-bound diff and one-time confirmation phrase. |
| `mijia_create_backup(fileName, outputDir, cloud)` | Create and verify a local backup; optionally create, poll, locate, download, and verify a gateway cloud backup. |
| `mijia_apply_change(planToken, backupReceipt, confirmation)` | Recheck, apply, and verify an allowlisted planned mutation. |
| `mijia_rollback(changeId, confirmation)` | Restore the saved object baseline and verify restoration. |

See [API reference](docs/api-reference.md), [protocol notes](docs/protocol.md),
[research basis](docs/research.md), [security model](docs/security.md), and
[troubleshooting](docs/troubleshooting.md).

## Development

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

Tests use a local fake gateway for protocol, JSON-RPC, timeout, validation,
backup, concurrent-change, and rollback behavior. Real gateway mutation is not
part of the normal test suite.

## License

[MIT](LICENSE)
