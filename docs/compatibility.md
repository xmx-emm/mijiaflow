# Compatibility

MijiaFlow applies a conservative compatibility policy. Read compatibility and
write compatibility are separate capabilities; successfully opening a socket
does not authorize mutation.

## Matrix

| Geek Edition frontend | Protocol header | Read path | Guarded write path | Notes |
| --- | --- | --- | --- | --- |
| `v1.6.1` | `2.0.0` | Targeted | Targeted | Initial supported pair; writes still require pairing, backup, a fresh baseline, and explicit confirmation. |
| `v1.6.1` | Unknown or missing | Read-only when probing succeeds | Disabled | Protocol identity is incomplete. |
| Unknown | `2.0.0` | Read-only when probing succeeds | Disabled | UI/object behavior has not been matched. |
| Unknown | Unknown or missing | Read-only when the current handshake succeeds | Disabled | No assumptions are made from transport success. |

"Targeted" describes the release compatibility contract. It is not a claim
that a particular user's gateway or every firmware build has been tested.

## Capability Selection

`mijia_probe` reads the public page metadata and protocol header before a
session is opened. The resulting capability mode is one of:

- `read-write`: the frontend/protocol pair is explicitly allowlisted.
- `read-only`: identification succeeded but the pair is not write-allowlisted.

An unreachable or unsafe target fails probing instead of receiving a capability
mode.

The mode is recomputed for a new session. It is not user-overridable, and a
plan token created under one capability mode cannot be reused after the target
or version changes.

## Browser Path

Browser automation depends on visible semantic labels rather than CSS class
names or copied frontend internals. A changed label, missing control, or
ambiguous match stops the interaction and requires a fresh observation. The
browser path does not convert an unfamiliar graph schema into a raw API write.

## Adding A Version

A new pair should remain read-only until maintainers have:

1. Captured version and protocol identification without credentials in logs.
2. Run the binary framing, key exchange, encryption, compression, and JSON-RPC
   suites against a local fake gateway.
3. Compared read responses and complete raw graph round-trips.
4. Exercised stale-baseline detection, backup verification, write readback, and
   object-level rollback on a disposable fixture.
5. Added the exact pair to the allowlist and this matrix.

Do not infer compatibility from a newer version number alone.

## Real-Device Acceptance Checklist

The automated suite covers protocol and transaction behavior against a local
fake gateway; it does not replace one guarded pass against real hardware.
Run this checklist against a physical gateway before trusting a release for
write operations, and record the results (date, firmware pair, outcomes,
non-secret error codes) in this file. Use a disposable automation and variable,
not production rules.

1. **Probe:** `mijia_probe` reports the expected frontend/protocol pair and
   mode; an intentionally wrong LAN address fails with `TARGET_UNREACHABLE`.
2. **Pairing:** `mijia_begin_session` opens the keypad page on `127.0.0.1`; a
   wrong passcode leads to a `failed` status and a fresh session is required; a
   correct passcode reaches `ready` and the page turns into the workbench.
3. **Reads:** each of `automations`, `devices`, `variables`, `logs`, and
   `backups` returns plausible data; an `id` read returns one complete raw
   graph.
4. **Local backup:** `mijia_create_backup` (default directory) writes a file
   whose digest verification passes and whose receipt is returned.
5. **Cloud backup (write-compatible pair only):** `mijia_create_backup` with
   `cloud: true` binds a new record, downloads it, and verifies content
   digests.
6. **Guarded write:** plan `set_graph_enabled` on the disposable automation,
   back up, confirm with the exact phrase, apply, and check the readback state
   in the native UI as well.
7. **Concurrent-change guard:** create a plan, toggle the same automation in
   the native UI, then apply; the tool must refuse with `CONCURRENT_CHANGE`
   without writing.
8. **Rollback:** roll the applied change back with the exact rollback phrase
   and verify the restored state through `mijia_read` and the native UI.
9. **End:** `mijia_end_session` closes the workbench page and invalidates the
   session; a subsequent read fails with `SESSION_NOT_READY`.

### Recorded Runs

None yet for the current release. Add entries here as
`YYYY-MM-DD - frontend/protocol - result summary`.
