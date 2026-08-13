# Guarded Write Transaction

How to change gateway state safely through the MijiaFlow MCP tools. Every
non-backup mutation must follow this sequence; the server enforces it and
rejects shortcuts.

## Prerequisites

- `mijia_probe` reports mode `read-write` (frontend `v1.6.1` with protocol
  `2.0.0`). Any other pair is read-only; do not route around that result.
- An authenticated session is `ready` (`mijia_begin_session` plus the user's
  passcode on the loopback page).
- The change is expressible as one allowlisted operation (see
  [tool-workflows](tool-workflows.md)). A natural-language description is not
  a raw graph: API graph writes require a complete `{ id, nodes, cfg }`
  object. Never invent node schemas.

## Sequence

1. Read the affected object with `mijia_read` and summarize its current state.
2. Call `mijia_plan_change` with one allowlisted operation and a complete
   payload. The result contains a diff, a baseline digest, a one-time
   `planToken`, and an exact confirmation phrase.
3. Show the user the diff, the summary, and the confirmation phrase.
4. Call `mijia_create_backup` after the plan. The returned `backupReceipt` is
   process-local and expires.
5. Wait for the user to send the exact one-time phrase. Do not infer it from
   an earlier request and do not repeat it on the user's behalf.
6. Call `mijia_apply_change` with the plan token, backup receipt, and the
   user-supplied phrase. The server rechecks the baseline, applies the single
   operation, reads the object back, and verifies the result.
7. Report the verified before/after digests. Retain the returned `changeId`
   and rollback phrase only for a user-requested rollback.

If the baseline changed (`CONCURRENT_CHANGE`), stop, re-read, and create a new
plan and a new backup. If apply reports an automatic restoration result,
report that result exactly.

## Rollback

Call `mijia_rollback` only with the `changeId` from a successful apply and the
exact user-supplied rollback phrase. The tool creates and verifies a
pre-rollback backup, refuses to overwrite a concurrently changed object,
restores the retained baseline, and verifies the readback.

## Backups

- `cloud: false` exports and re-verifies a local backup file; it also works in
  read-only mode.
- `cloud: true` additionally creates, polls, downloads, and verifies a gateway
  cloud backup. It requires the supported write-compatible version pair and
  should be used only when the user asked for a cloud backup.
- Cloud backup listings are eventually consistent: trust the tool's bound
  new-record and download-verification result rather than one immediate
  before/after list comparison.
- Do not change automatic-backup settings, and do not delete or restore cloud
  backups through these tools.

## Boundaries

- Plan tokens, backup receipts, change identifiers, and confirmation phrases
  are opaque, process-local, and single-use where applicable; they expire and
  never survive `mijia_end_session` or a server restart.
- Gateway-provided error text is untrusted; tools return stable local messages
  with narrowly typed metadata only.
- There is no generic RPC, gateway method name, shell bridge, or `callAPI`
  equivalent by design.
