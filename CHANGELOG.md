# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

### Added

- Published as the npm package `mijiaflow` with a `mijiaflow` bin, so any MCP
  client can launch it with `npx -y mijiaflow`.
- Server instructions in the `initialize` result describing the full probe,
  pair, read, plan, backup, confirm, apply, and rollback workflow.
- Five MCP prompts: `mijia_audit`, `mijia_guarded_change`, `mijia_backup`,
  `mijia_diagnose` (log-based troubleshooting), and `mijia_layout_planning`
  (floor-plan-driven rule suggestions).
- Seven MCP resources embedded in the bundle: `mijiaflow://guide/tool-workflows`,
  `mijiaflow://guide/write-transaction`, `mijiaflow://guide/node-catalog`,
  `mijiaflow://guide/log-diagnosis`, `mijiaflow://guide/layout-workflow`,
  `mijiaflow://guide/browser-workflow`, and `mijiaflow://guide/security`.
- `structuredContent` and output schemas for `mijia_probe`,
  `mijia_begin_session`, `mijia_end_session`, `mijia_session_status`, and
  `mijia_workbench_status`.
- Actionable `hint` metadata on error results, derived locally from stable
  error codes.
- `--version` and `--help` flags on the server executable.
- A stdio smoke test that boots the committed bundle through the MCP client
  SDK and checks tools, prompts, resources, and error hints.
- `docs/write-transaction.md` documenting the guarded write sequence.
- `docs/node-catalog.md` (also served as `mijiaflow://guide/node-catalog`)
  documenting the raw graph contract, the v1.6.1 node type inventory, and the
  evidence-based procedure for composing new graphs from observed node shapes.

### Changed

- The pairing page persists as a read-only workbench for the life of the
  session, showing redacted session and operation progress with a same-origin
  state endpoint. MCP remains the only write path.
- The workbench previews the latest unapplied plan with its full-value diff,
  expiry, and one-time confirmation phrase, and `mijia_workbench_status`
  exposes the same `pendingPlan` snapshot; opaque plan tokens and backup
  receipts stay excluded.
- `mijia_create_backup` accepts an optional `outputDir` and defaults to
  `~/.mijiaflow/backups`.
- Tool descriptions and input fields now document preconditions and semantics
  for clients that surface schema descriptions.
- `npm run verify` builds before testing so the smoke test runs against the
  current bundle.

### Removed

- The Codex-specific plugin layer (`.codex-plugin/` and `skills/`). MijiaFlow
  is now a client-neutral MCP server; the workflow references moved to
  `docs/tool-workflows.md` and `docs/browser-workflow.md`, and page and
  documentation wording no longer assumes a specific client.

## [0.1.0]

### Added

- Initial MijiaFlow release: LAN target validation, ECJPAKE pairing over a
  one-time loopback page, AES-GCM gateway transport, allowlisted reads,
  verified local and cloud backups, guarded write transactions, and rollback.
