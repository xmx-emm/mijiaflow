# Local Protocol Notes

This document records the interoperability target implemented independently by
MijiaFlow. It is not an official Xiaomi specification and does not include or
redistribute Xiaomi frontend source code.

## Transport

- Gateway page: `http://<gateway>/` or HTTPS where configured
- WebSocket path: `/centrallinkws/`
- Application protocol list advertised after WebSocket open: `["passcode"]`
- Application frames: binary
- RPC convention: JSON-RPC 2.0 methods named `/api/<allowlisted-method>`

MijiaFlow validates that the target remains a private/LAN destination before
HTTP requests, redirects, DNS re-resolution, and WebSocket connection.

## Frame Types

The targeted `2.0.0` handshake uses these message identifiers:

| Type | Meaning |
| ---: | --- |
| `1` | Supported protocol list |
| `2` | Selected protocol |
| `3` | Session key exchange |
| `4` | Protocol error |
| `5` | Encrypted application data |
| `16` | Server public key |
| `32` | ECJPAKE round |
| `33` | ECJPAKE round |

Unexpected order, unknown mandatory fields, oversized frames, malformed points,
authentication failure, and timeouts abort the handshake. Error frames are
mapped to bounded MCP errors without logging authentication material.

## Pairing And Session Keys

The pairing sequence is:

```text
loopback MijiaFlow keypad
  -> one six-digit HTTP POST
  -> open /centrallinkws/
  -> ECJPAKE authentication
  -> retain the non-secret terminal page for 60 seconds
```

The passcode-authenticated exchange uses ECJPAKE over `secp256k1`. MijiaFlow
performs point and scalar validation and derives session material only after the
exchange authenticates. The passcode enters through the one-time loopback page
and remains in process memory only for the authentication handshake.

Encrypted application frames use:

- AES-128-GCM
- 16-byte session key
- 8-byte session salt
- 32-bit little-endian message counter starting at `1`
- 16-byte authentication tag

The 12-byte nonce is the session salt combined with the current counter. A
counter is never reused with a key/salt pair. Authentication is verified before
decompression or JSON parsing; exhaustion or ordering violations close the
session.

## Application Payload

The authenticated plaintext is raw-DEFLATE-compressed UTF-8 JSON. After bounded
decompression, it must be a JSON-RPC 2.0 request or response. MijiaFlow correlates
responses by request identifier, enforces deadlines, rejects duplicate terminal
responses, and limits methods to its internal allowlist.

Conceptually:

```text
JSON-RPC object
  -> UTF-8 JSON
  -> Raw DEFLATE
  -> AES-128-GCM ciphertext + tag
  -> type-5 binary frame
```

Decryption performs the reverse sequence only after the GCM tag passes.

## Backup File

The targeted local backup payload is a raw-DEFLATE-compressed JSON document:

```json
{
  "version": 2,
  "rules": [
    { "id": "graph-id", "cfg": { "id": "graph-id", "enable": true }, "nodes": [] }
  ],
  "variables": {}
}
```

A 32-byte SHA-256 digest is appended to the compressed bytes. Verification
separates the trailing digest, hashes the compressed payload, compares in
constant time, then performs bounded decompression and schema validation. A
digest match alone does not prove that every object required for a proposed
change is present; the backup receipt also records coverage.

## Method Boundary

The gateway exposes more local RPC methods than MijiaFlow publishes. The server
maps each public MCP operation to a fixed internal method and validates both its
request and response. It never accepts a caller-provided `/api/...` method name.

Method families required by the public feature set cover graph reads and fixed
graph mutations, device reads, log reads, scoped variable operations, and
backup list/create/progress/download operations. See
[the MCP API reference](api-reference.md) for the stable public boundary.
