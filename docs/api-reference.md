# MCP API Reference

MijiaFlow exposes ten tools, three prompts, and four guide resources. There is
no generic RPC, arbitrary method, shell, or `callAPI` interface. Tool errors use
MCP error results and redact passcodes, session keys, pairing tokens, and
decrypted protocol payloads where they may contain secrets. Gateway-provided
JSON-RPC error messages are treated as untrusted payloads: callers receive the
stable message `Gateway RPC failed` and, when present, only the numeric
`rpcCode` metadata.

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

## Result Shapes

Every tool returns its payload as pretty-printed JSON text content.
`mijia_probe`, `mijia_begin_session`, `mijia_end_session`,
`mijia_session_status`, and `mijia_workbench_status` also declare an
`outputSchema` and return the same object as `structuredContent`, so clients
can consume them without parsing text.

Error results set `isError` and contain a JSON object with a stable `error`
code, a stable local `message`, an actionable `hint` for known codes, and
narrowly typed `details` when available. The `hint` is generated locally from
the error code and never derived from gateway-provided text. For example, a
call that needs an authenticated session returns:

```json
{
  "error": "SESSION_NOT_READY",
  "message": "No authenticated Mijia session is ready",
  "hint": "Call mijia_begin_session, have the user enter the passcode on the 127.0.0.1 page, and poll mijia_session_status until it reports ready."
}
```

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
page accepts exactly one authentication submission. After submission the same
token-bound URL keeps serving a read-only workbench with redacted session and
operation progress until the session ends, but a retry always requires a new
`mijia_begin_session` call and URL. Closing the browser page does not itself
cancel a still-pending server-side pairing session.

## `mijia_end_session`

Closes the WebSocket, invalidates plans and receipts, clears passcode-derived
material, and stops the loopback pairing listener.

```json
{}
```

This operation is idempotent.

## `mijia_session_status`

Reports the current session state without opening a connection or touching the
gateway. Use it to poll pairing progress after `mijia_begin_session` instead of
probing with reads that fail while the user is still typing the passcode.

```json
{}
```

The result contains a `state` of `none`, `awaiting-passcode`, `authenticating`,
`ready`, or `failed`. While a session exists it also reports the session
identifier, normalized target, compatibility mode, and any write-disabled
reasons. While the state is `awaiting-passcode` it includes the pairing-page
expiry. It never returns the pairing URL, the passcode, or session key
material. A `failed` state means the last pairing or connection attempt ended;
recovery always goes through a new `mijia_begin_session` call.

## `mijia_workbench_status`

Returns the redacted session and recent-operation snapshot rendered by the
loopback workbench. It can show the current stage (`read`, `plan`, `backup`,
`apply`, `verify`, or `rollback`), bounded diff entries, stable result metadata,
and local error categories. It never returns the loopback URL, passcode, opaque
transaction handles, confirmation phrases, backup paths, full payloads, device
data, or gateway-originated error text.

```json
{}
```

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

`outputDir` is optional. When omitted, the backup is written to
`~/.mijiaflow/backups`. When provided it must be an absolute path, and
`fileName` must be a plain portable filename without directory segments.

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

## Prompts

The server registers three prompts so clients can start a correct workflow
without external instructions. Each returns a single user message.

| Prompt | Arguments | Purpose |
| --- | --- | --- |
| `mijia_audit` | `baseUrl` | Probe, pair, and inspect automations, devices, variables, and logs without changing anything. |
| `mijia_guarded_change` | `baseUrl`, `change` | Run the full guarded write transaction for one described change. |
| `mijia_backup` | `baseUrl`, `cloud?` | Create a verified local backup, and a verified cloud backup when `cloud` is `"cloud"`. |

## Resources

Guide documents are embedded in the bundle and served as `text/markdown`, so
they are available to any client regardless of how the package was installed.

| URI | Contents |
| --- | --- |
| `mijiaflow://guide/tool-workflows` | Read filters, allowlisted operations, and opaque token handling. |
| `mijiaflow://guide/write-transaction` | The mandatory plan, backup, confirm, apply, verify, and rollback sequence. |
| `mijiaflow://guide/browser-workflow` | Optional guidance for browser-capable agents. |
| `mijiaflow://guide/security` | Trust boundaries, credential lifecycle, and enforced mutation gates. |

## Server Instructions

The `initialize` result carries server instructions summarizing the whole flow
(probe, pair on the loopback page, poll status, read, plan, back up, confirm,
apply, roll back, end session) together with the safety rules. Clients that
surface server instructions to the model do not need any additional prompt
engineering to use MijiaFlow correctly.

## Browser Operations

Browser control is described by the [browser workflow guide](browser-workflow.md)
for agents with browser capabilities; it is not exposed as an MCP RPC method.
The agent observes the current Mijia page and works through semantic labels.
Before every native write, the workflow retains the API baseline, creates and
verifies a local backup, rechecks the baseline, and waits for a fresh exact
browser confirmation. The agent then reopens the UI and performs an API
readback. Browser and API sessions are not a single atomic transaction.
