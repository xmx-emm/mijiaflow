# Floor Plan Planning Workflow

How to turn a floor plan and the gateway's device inventory into reviewed,
guarded automation suggestions. This workflow needs an AI client that can view
images in the conversation; the floor plan itself never touches the gateway
and is not stored by MijiaFlow.

## Inputs

- A floor plan image attached by the user in the conversation (any legible
  sketch, screenshot, or photo works).
- The device inventory from `mijia_read` devices on an authenticated session.
- Optionally, the user's own device-to-room assignments; otherwise propose a
  mapping and let the user correct it.

## Steps

1. **Inventory:** read devices (and existing automations) first. Build a table
   of device id, name, kind, and online state. Never suggest rules for devices
   that do not exist on the gateway.
2. **Understand the layout:** from the image, identify rooms, entrances,
   hallways, windows, and adjacencies. State the reading back to the user in
   one short list so misreadings are caught early.
3. **Map devices to rooms:** propose the device-to-room mapping (device names
   often carry room hints); ask the user to confirm or fix it. Do not proceed
   on a guessed mapping the user has not seen.
4. **Propose rules per zone:** for each room or zone, suggest a small set of
   rules with a one-line rationale, for example presence-based lighting in
   hallways, entrance notifications, window/climate interlocks, night modes in
   bedrooms, and safety cutoffs in kitchens. Distinguish suggestions that are
   implementable with the current devices from ideas that would need new
   hardware.
5. **Review before writing:** present the full suggestion list and let the
   user pick. Nothing is written during planning.
6. **Implement the accepted rules** one at a time through the guarded write
   transaction, composing graphs only per the
   [node catalog](node-catalog.md) evidence procedure. Create new rules with
   `enable: false` first so the user can inspect them in the native Mijia UI,
   then enable them with a separate guarded change.

## Boundaries

- The floor plan stays in the conversation; MijiaFlow has no tool that
  uploads, stores, or transmits it.
- Room assignments are planning context, not gateway state; re-confirm them in
  a later session instead of assuming they persisted.
- Suggestions must respect the compatibility mode: on a read-only gateway,
  present the plan and stop at the point where writes would begin.
