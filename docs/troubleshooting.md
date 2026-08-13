# Troubleshooting

## Probe Cannot Reach The Gateway

1. Open the same `baseUrl` from the machine running Codex.
2. Use the gateway's private IP or trusted local hostname, including the scheme.
3. Confirm that Codex and the gateway are on reachable LAN segments and that
   client isolation is not blocking them.
4. Remove any remote HTTP proxy from the local route. MijiaFlow bypasses proxy
   use for private and loopback targets.
5. Probe again after an IP change; plans and sessions are target-bound.

Public internet addresses and a local hostname that resolves to a public address
are rejected intentionally.

## Version Is Read-Only

Compare both values returned by `mijia_probe` with the
[compatibility matrix](compatibility.md). Frontend `v1.6.1` without protocol
`2.0.0`, protocol `2.0.0` with an unknown frontend, and missing version metadata
all remain read-only. Re-pairing does not override compatibility mode.

Operate the gateway UI manually outside MijiaFlow for an unsupported graph
workflow, or wait until the exact version pair has been validated and
allowlisted. MijiaFlow itself does not automate writes on an unknown pair.

## Pairing Page Does Not Open

- Open the returned URL on the same computer as the MCP server.
- Confirm that the host is exactly `127.0.0.1`, not the gateway address.
- Use the newest URL; pairing tokens are short-lived and single-use.
- End the session and begin again if the MCP process restarted.
- Check whether endpoint security software blocked the temporary loopback
  listener.

After a successful or failed submission, the same URL can refresh the non-secret
read-only workbench. Keep it open to observe session and recent operation
progress. It closes after `mijia_end_session`, process shutdown, or an
unsubmitted pairing-page expiry.

`mijia_session_status` reports whether the server still holds a pending
session (`awaiting-passcode`) or the attempt already ended (`failed` or
`none`) without exposing the pairing URL again.

Do not place the gateway passcode in a Codex prompt or tool call.

## Incorrect Passcode Or Handshake Timeout

An incorrect passcode, invalid ECJPAKE frame, or expired deadline closes the
attempt and clears derived material. Start a new session to obtain a new pairing
URL. The submitted URL becomes the workbench and cannot accept a second
authentication attempt. Reusing it or an old plan token will fail by design.
`mijia_session_status` reports `failed` during that window; the only recovery
is a new `mijia_begin_session`.

Check the gateway clock/network stability and verify that the page belongs to
the current MijiaFlow process before trying again.

## Read Times Out

- Retry a narrow resource read, for example one automation ID instead of an
  entire log window.
- Reduce log time ranges or page sizes.
- Confirm the gateway page remains responsive from the same machine.
- End and re-create the session after a network transition or gateway restart.

MijiaFlow does not retry a write automatically after an ambiguous timeout.

## Plan Is Stale

`mijia_apply_change` re-reads the object immediately before mutation. If its
digest differs from the plan baseline, another browser, app, automation, or
session changed the object. Read the new state, review the difference, create a
new plan, and create a fresh verified backup. Do not reuse the old confirmation
phrase.

## Backup Receipt Is Rejected

A backup path is not a receipt. Create the backup through
`mijia_create_backup`, keep the MCP process running, and use the opaque receipt
it returns. Receipts fail after session end, process restart, expiry, target
change, digest mismatch, or insufficient object coverage.

For a cloud backup, wait for generation to finish and for the downloaded file
to pass digest and schema validation. Backup-list publication is eventually
consistent, so a single immediate before/after list comparison is not decisive.
`BACKUP_NOT_FOUND` means progress reached 100 but no new matching record became
visible during the bounded list-polling window; it does not trigger another
cloud backup creation.

## Confirmation Is Rejected

Use the exact, case-sensitive, one-time phrase returned for that plan or change.
Extra whitespace, translated text, a phrase from another plan, and an expired or
already used phrase are rejected. Generate a new plan instead of weakening the
check.

## Post-Write Verification Failed

The result distinguishes the original write/readback error from the automatic
object-level restoration attempt. Stop further writes and preserve the result
and backup. If `recoveryAvailable` is true, show the returned guarded recovery
details and wait for the exact rollback phrase before calling `mijia_rollback`.
If it is false, no safe current-state digest was established; inspect the object
read-only and do not invent a change identifier or retry the write.

## Browser Labels Are Missing Or Ambiguous

Refresh and re-observe the page, then navigate from a stable visible heading.
Do not substitute guessed selectors or click by screen coordinates when several
controls match. A frontend update may require the Skill's semantic workflow to
be updated even when the local API remains readable.

## Collecting A Report

Include these non-secret facts in an issue:

- MijiaFlow version and Node.js version
- Operating system and Codex Desktop/CLI version
- Frontend version, protocol header, and capability mode from `mijia_probe`
- Tool name, error category, and timestamp
- Whether the target was an IP address or local hostname

Remove gateway passcodes, pairing URLs/tokens, session material, complete
decrypted frames, device identifiers, automation contents, variable values, and
backup files before sharing a report.
