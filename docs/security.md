# Security Model

MijiaFlow operates against home automation infrastructure on a local network.
Its design minimizes credential exposure and makes every non-backup mutation an
explicit, baseline-bound transaction.

## Trust Boundary

Trusted components:

- The local Codex process and MijiaFlow MCP subprocess
- The one-time page opened on the same machine
- The selected Mijia Central Hub and trusted LAN path
- A backup output directory chosen by the user

Untrusted inputs include gateway frames, HTTP redirects, DNS answers, browser
page changes, tool payloads, filenames, decompressed JSON, and stale plans.

## Target Restrictions

MijiaFlow accepts only loopback, private, or link-local gateway destinations.
It validates the URL scheme, resolved addresses, redirects, and the destination
again before opening the WebSocket. This prevents the MCP tools from becoming a
general HTTP/WebSocket client and limits DNS-rebinding and redirect-based SSRF.

The loopback pairing listener binds only `127.0.0.1`, uses a random single-use
token, applies a short expiry, and accepts a bounded request body. It opens the
gateway WebSocket only after the request source, format, and six-digit passcode
shape pass validation. After the first authentication submission it rejects all
later POST requests, while a non-secret terminal result remains available to GET
for 60 seconds. The listener then stops, and also stops on an unsubmitted expiry
or explicit session end.

## Credential Lifecycle

- The passcode is accepted only by the loopback pairing page.
- It is never present in MCP tool schemas or ordinary Codex messages.
- It is not persisted in source files, environment files, plugin settings,
  backup receipts, or logs.
- Passcode-derived secrets, ECJPAKE state, AES keys, salts, counters, and pairing
  tokens remain process-local and are cleared on failure or session end.
- Log redaction covers authentication inputs, secret material, opaque tokens,
  and decrypted values that may be sensitive.

JavaScript cannot guarantee physical zeroization of every runtime copy. The
server therefore minimizes lifetime and references and relies on process
termination as the final memory boundary.

## Cryptographic Boundary

The targeted protocol uses ECJPAKE on `secp256k1` for passcode authentication
and AES-128-GCM for session data. MijiaFlow validates points, tags, counters,
frame sizes, decompression limits, JSON shape, and request correlation before
data reaches the tool layer. Failed authentication never falls back to an
unencrypted session.

See [protocol notes](protocol.md) for interoperable parameters.

## Mutation Transaction

Except for creating a backup, every mutation requires all of these gates. The
MCP server enforces them for API writes; the Skill enforces the same sequence
before invoking a native browser save or confirmation control:

1. A recognized write-compatible version pair.
2. A validated allowlisted operation and complete payload.
3. A canonical baseline read and digest.
4. A newly exported backup whose digest, schema, and object coverage pass.
5. A second baseline read that matches the plan.
6. The exact one-time user confirmation phrase.
7. A single write followed by authoritative readback.
8. A retained object baseline and verified rollback path.

Plan tokens, backup receipts, confirmation phrases, and change identifiers are
opaque, short-lived, session/target-bound, and single-use where applicable.
They prevent parameter substitution; they are not bearer credentials for a
general gateway API.

Natural-language automation design stays in the browser. The API accepts only
a complete raw graph `{ id, nodes, cfg }` and never guesses node types, ports,
edges, device capabilities, or hidden configuration.

## Backup Handling

Local backups may contain automation logic, device references, variable names,
and variable values. MijiaFlow verifies the backup digest and structure but does
not make the output directory private by itself. Store backups in a directory
protected by the operating system, avoid syncing them unintentionally, and
delete obsolete copies according to the user's retention policy.

Cloud backup creation uses only the gateway's dedicated backup functions. It is
disabled for unknown version pairs and does not change backup schedules or
configuration as a side effect.

## Browser Boundary

Browser actions occur in the visible Mijia UI and are not atomically coupled to
the MCP session. Before a browser write, the Skill retains the authoritative raw
baseline, creates and verifies a full backup, rechecks the baseline, and waits
for a fresh exact browser confirmation phrase. After the native save, it reopens
the UI and performs an API readback. Any baseline drift stops the workflow.

## Explicit Non-Goals

MijiaFlow does not:

- expose a generic `callAPI`, arbitrary RPC, HTTP, WebSocket, or shell tool;
- store the gateway passcode for unattended reuse;
- treat unknown frontend/protocol versions as write-compatible;
- infer raw graph structures from natural language;
- copy, bundle, or execute Xiaomi frontend source code; or
- integrate with the restricted Xiaomi Home Assistant cloud interface.

MijiaFlow is an unofficial interoperability project and receives no security or
compatibility guarantees from Xiaomi, Mijia, or Xiaomi Home.
