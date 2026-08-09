# MCP API Reference

MijiaFlow exposes eight tools. There is no generic RPC, arbitrary method, shell,
or `callAPI` interface. Tool errors use MCP error results and redact passcodes,
session keys, pairing tokens, and decrypted protocol payloads where they may
contain secrets.

## Shared Rules

- `baseUrl` must resolve to an allowed private, loopback, or link-local gateway
  target. Redirects and resolution changes are revalidated.
- Only one in-memory gateway session is active per MCP server process.
- The gateway passcode is never a tool parameter.
- Unknown frontend/protocol pairs cannot create or apply mutation plans.
- Tokens and receipts are opaque, short-lived, process-local values. They are
  invalid after `mijia_end_session` or a server restart.
- A natural-language description is not a raw graph. API graph writes require
  a complete `{ id, nodes, cfg }` object.

## `mijia_probe`

Inspects public gateway metadata and reports the compatibility mode. It does
not request or retain a passcode.

```json
{ "baseUrl": "http://GATEWAY_IP/" }
```

`GATEWAY_IP` is a placeholder. Every caller supplies the LAN address of their
own gateway; MijiaFlow does not ship with a machine-specific target address.

The result includes the normalized target, detected frontend version, detected
protocol header, transport availability, capability mode, and any reasons that
write mode is disabled.

## `mijia_begin_session`

Starts a pending in-memory session and returns an expiring HTTP URL bound to
`127.0.0.1`. Open its MijiaFlow six-digit keypad locally and enter the gateway
passcode there. The gateway WebSocket is not opened until the form is submitted.

```json
{ "baseUrl": "http://GATEWAY_IP/" }
```

The result reports pairing state and expiry without echoing the passcode. The
page accepts exactly one authentication submission. Its non-secret success or
failure result remains available to GET and refresh for 60 seconds, but a retry
always requires a new `mijia_begin_session` call and URL. Closing the browser
page does not itself cancel a still-pending server-side pairing session.

## `mijia_end_session`

Closes the WebSocket, invalidates plans and receipts, clears passcode-derived
material, and stops the loopback pairing listener.

```json
{}
```

This operation is idempotent.

## `mijia_read`

Reads one allowlisted resource from the authenticated gateway session.

```json
{
  "resource": "automations",
  "filters": { "id": "optional-object-id" }
}
```

Supported resources:

| Resource | Typical filters | Result |
| --- | --- | --- |
| `automations` | `id`, `enabled`, `includeNodes` | Graph summaries, all complete graphs, or one complete graph. |
| `devices` | `id`, `available` | Device metadata and observed availability. |
| `variables` | `scope`, `id` | Variable definitions and current values. |
| `logs` | `page`, `pages` (maximum 20) | Raw gateway log pages. |
| `backups` | `from: "fds"` | Cloud backup records. |

Unsupported filter keys are rejected rather than forwarded. Log pagination is
explicit; other resources return the selected gateway result in one call. The
cloud backup list is eventually consistent, so a completed backup can be absent
from an immediate standalone `mijia_read` response.

## `mijia_plan_change`

Validates one allowlisted mutation, reads its object baseline, and returns an
opaque plan token, a canonical diff, a human-readable summary, the baseline
digest, and an exact one-time confirmation phrase.

```json
{
  "operation": "set_graph",
  "payload": {
    "id": "graph-id",
    "nodes": [
      {
        "id": "node1",
        "type": "nop",
        "props": {},
        "inputs": {},
        "outputs": {},
        "cfg": { "version": 1 }
      }
    ],
    "cfg": { "id": "graph-id", "enable": false }
  }
}
```

Allowlisted operations are `set_graph`, `delete_graph`, `set_graph_config`,
`set_graph_enabled`, `create_variable`, `set_variable_value`,
`set_variable_config`, and `delete_variable`. Each operation uses a closed
validation schema. Unknown fields, partial raw graphs, and arbitrary RPC method
names are rejected. Complete graph/config writes require `cfg.id === id` and a
boolean `cfg.enable`. Nodes use the observed v1.6.1 shape and output connections
must resolve to an existing node input.

Planning performs no write. A plan is bound to the target, session, operation,
payload digest, object identifier, and baseline digest. It expires and can be
used only once.

## `mijia_create_backup`

Creates a local backup file and verifies its trailing SHA-256 digest. When
`cloud` is `true`, it requests a backup through the gateway's dedicated API,
polls progress to 100, then waits up to 30 seconds for an eventually consistent
list result. The selected record must have the requested filename and an
identity absent from the pre-create baseline. Only then is that exact record
downloaded and its content verified. If no new matching record appears, the
tool returns `BACKUP_NOT_FOUND` and does not create a second backup.

```json
{
  "fileName": "before-hallway-change.mijiaflow",
  "outputDir": "C:\\Users\\me\\Documents\\MijiaFlow",
  "cloud": false
}
```

The result includes an opaque `backupReceipt`, file metadata, content digest,
coverage metadata, and cloud status when requested. The receipt is required by
`mijia_apply_change`; a filename alone is not proof of a valid backup.

Backup creation is the only write-like operation that does not require a prior
change plan. A local backup is a read-only export and remains available in
read-only compatibility mode. `cloud: true` invokes a gateway write and is
therefore allowed only for an explicitly write-compatible version pair. Setting
backup schedules or changing backup configuration is not part of this tool.

## `mijia_apply_change`

Consumes a plan and verified backup receipt after matching the exact one-time
confirmation phrase.

```json
{
  "planToken": "opaque-plan-token",
  "backupReceipt": "opaque-backup-receipt",
  "confirmation": "exact phrase returned by mijia_plan_change"
}
```

Before writing, the tool re-reads the target and compares its digest with the
planned baseline. A mismatch produces a concurrent-change error and consumes
no mutation. On a match, it executes the one allowlisted operation, reads the
object back, and verifies the expected state.

Success returns a `changeId`, before/after digests, verification status, and an
exact one-time rollback confirmation phrase. If post-write verification fails,
the implementation attempts object-level restoration and reports both the
original failure and restoration result. When restoration cannot be verified
but the current object can be read, the error also returns a guarded recovery
`changeId`, rollback phrase, expiry, and current guard digest. No recovery handle
is issued when the current object cannot be read safely.

## `mijia_rollback`

Restores the object baseline retained for a previously applied change.

```json
{
  "changeId": "opaque-change-id",
  "confirmation": "exact rollback phrase returned by mijia_apply_change"
}
```

Rollback is target-, session-, and change-bound. It refuses an expired or
already consumed confirmation, rechecks the current object, performs the
allowlisted inverse/restore action, and reads back the restored state. The
result reports the restored baseline digest and verification status.

## Browser Operations

Browser control is orchestrated by the MijiaFlow Skill, not exposed as an MCP
RPC method. Codex observes the current Mijia page and works through semantic
labels. Before every native write, the Skill retains the API baseline, creates
and verifies a local backup, rechecks the baseline, and waits for a fresh exact
browser confirmation. It then reopens the UI and performs an API readback.
Browser and API sessions are not a single atomic transaction.
