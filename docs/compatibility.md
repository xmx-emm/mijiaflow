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
