# Node Catalog And Evidence-Based Graph Composition

How to compose a new automation graph for `set_graph` without guessing. This
catalog separates what the server can verify from what must be observed on the
target gateway before it is used.

Two trust levels apply:

- **Structure (enforced):** the raw graph contract below is validated by the
  server on every `set_graph` plan. A payload that violates it never reaches
  the gateway.
- **Semantics (observed):** what each node type does, which `props` it takes,
  and which ports it exposes are not shipped with MijiaFlow. They must be
  observed from real automations on the target gateway before composing with
  that type.

## Raw Graph Contract

A complete graph is `{ id, nodes, cfg }`:

- `id`: non-empty string; must equal `cfg.id`.
- `cfg`: `{ id, enable: boolean, ... }`. Extra observed fields (for example a
  display name) are passed through verbatim; keep them when editing.
- `nodes`: array of nodes. Each node is:
  - `id`: unique within the graph, letters and digits only.
  - `type`: one of the allowlisted v1.6.1 types listed below.
  - `props`: object with the node's configuration values.
  - `inputs`: object whose keys are the node's input port names.
  - `outputs`: object mapping each output port name to an array of
    connections, each written as `"destinationNodeId.destinationInput"`.
  - `cfg`: object with at least an integer `version`.

Every connection must resolve to an existing node and one of its declared
input ports inside the same graph; dangling references are rejected. A minimal
valid wiring, taken from the test corpus:

```json
{
  "id": "rule-1",
  "cfg": { "id": "rule-1", "enable": true },
  "nodes": [
    {
      "id": "source1",
      "type": "onLoad",
      "props": {},
      "inputs": {},
      "outputs": { "output": ["target1.input"] },
      "cfg": { "version": 1 }
    },
    {
      "id": "target1",
      "type": "nop",
      "props": {},
      "inputs": { "input": {} },
      "outputs": {},
      "cfg": { "version": 1 }
    }
  ]
}
```

## Node Type Inventory

The allowlist contains 26 node types observed in frontend `v1.6.1`. Roles
below are inferred from the type names and the native UI vocabulary; treat
every row as **name-inferred** until an observed shape for the target gateway
is recorded under "Observed Shapes".

| Type | Category | Inferred role |
| --- | --- | --- |
| `deviceInput` | Trigger | Device event or property change starts/feeds the rule. |
| `alarmClock` | Trigger | Scheduled clock trigger. |
| `timeRange` | Trigger/guard | Active time window. |
| `varChange` | Trigger | Fires when a variable changes. |
| `onLoad` | Trigger | Fires when the rule is loaded/enabled. |
| `deviceOutput` | Device I/O | Sends a command to a device. |
| `deviceGet` | Device I/O | Reads a device property on demand. |
| `signalOr` | Logic | Merges multiple signal paths. |
| `logicOr` | Logic | Boolean OR. |
| `logicAnd` | Logic | Boolean AND. |
| `logicNot` | Logic | Boolean NOT. |
| `condition` | Logic | Value comparison / branch guard. |
| `delay` | Flow | Delays propagation. |
| `loop` | Flow | Repeats a section. |
| `onlyNTimes` | Flow | Limits how often a path fires. |
| `counter` | Flow | Counts events. |
| `modeSwitch` | Flow | Multi-way branch by mode. |
| `register` | Flow | Stores a value for later use. |
| `eventSequence` | Flow | Requires events in sequence. |
| `statusLast` | Flow | Holds/queries the last status. |
| `nop` | Flow | Pass-through placeholder. |
| `varGet` | Variable | Reads a variable. |
| `varSetNumber` | Variable | Writes a number variable. |
| `varSetString` | Variable | Writes a string variable. |
| `deviceInputSetVar` | Variable | Stores a device event value into a variable. |
| `deviceGetSetVar` | Variable | Stores a read device property into a variable. |

## Composition Procedure

Composing a new graph is allowed only through this evidence-based procedure.
"I have seen this node type on this gateway" is the requirement; a plausible
guess is not.

1. **Inventory:** `mijia_read` automations (summaries), and identify existing
   rules similar to the desired behavior.
2. **Observe:** read those rules completely (`{ "id": ..., }` or
   `includeNodes: true`) and record, for every node type you plan to use: its
   `props` keys and value shapes, `inputs` port names, `outputs` port names,
   and `cfg` extras.
3. **Compose from observations only:** reuse the observed shapes verbatim,
   changing only the values that express the new behavior (device ids,
   thresholds, wiring). Keep unknown observed fields as-is. Do not invent a
   `props` key, port name, or `cfg` field you have not seen on this gateway.
4. **Prefer clone-and-modify:** when a similar rule exists, start from its
   complete graph and edit, rather than assembling from scratch.
5. **Stop when evidence is missing:** if a needed node type has never been
   observed on this gateway, do not guess. Create one example manually in the
   native UI first (or via the browser workflow), read it back, and then
   compose.
6. **Guarded write as always:** `mijia_plan_change` with the complete graph,
   review the diff, `mijia_create_backup`, exact user confirmation,
   `mijia_apply_change`, readback, and a behavior check in the native UI.

New rules should start with `enable: false` when the user wants to inspect
them in the native UI before activation.

## Observed Shapes

Record verified node shapes per firmware pair here, so later compositions can
rely on them. Suggested format:

```text
### v1.6.1 / 2.0.0 - <type> (verified YYYY-MM-DD)
props: { ... }        # keys and value kinds, values redacted where private
inputs: [ ... ]       # port names
outputs: [ ... ]      # port names
cfg extras: { ... }
source: automation <id> read on the target gateway
```

None recorded yet for the current release.
