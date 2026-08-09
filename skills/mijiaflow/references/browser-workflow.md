# Browser Workflow

## Inspect Or Draft

1. Open or reuse the user's Mijia Geek Edition gateway page.
2. Inspect visible state and semantic labels before acting.
3. Navigate native lists, menus, forms, and graph controls only by accessible names or visible labels.
4. Read the current graph, enabled state, warnings, and missing-device indicators.
5. Use the native UI to compose nodes and connections. Never translate guessed node JSON into an API write.

Inspection and editing a still-unsaved draft are read-only. Stop before any
native control that persists, deletes, enables, disables, or submits data.

## Commit A Browser Change

For every non-backup browser write:

1. Establish an authenticated MijiaFlow API session and read the complete affected automation. For a create, record that its ID does not yet exist.
2. Retain that raw response as the object baseline and summarize the visible intended change.
3. Call `mijia_create_backup` with `cloud: false` and a durable absolute directory. Reopen and verify the returned receipt.
4. Re-read the complete affected automation and require it to equal the retained baseline. Stop and restart if it changed.
5. Generate a fresh phrase in the form `CONFIRM MIJIAFLOW BROWSER <random-hex>` and show it with the automation ID and intended effect.
6. Wait for the user to return that exact phrase after seeing the final UI draft. Do not reuse an earlier request or API confirmation.
7. Recheck that the page still shows the same draft and target automation, then invoke the single native save/confirm control.
8. Reopen the automation in the UI and verify the visible nodes, connections, name, and enabled state.
9. Re-read the automation through `mijia_read` with `includeNodes: true` and compare the authoritative result with the visible outcome.
10. Retain the baseline and backup receipt for recovery. Use a new guarded API plan or the same browser transaction sequence for any rollback.

Prefer the API transaction for enable/disable and variable operations because
it enforces these gates in code. Do not continue a browser write when the API
session or backup cannot be completed.

Do not paste the gateway passcode into browser automation logs or chat. The MCP
API session uses its own one-time MijiaFlow six-digit keypad and opens the
gateway WebSocket only after the user submits that page.
