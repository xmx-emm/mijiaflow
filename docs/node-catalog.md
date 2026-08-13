# Node Catalog And Evidence-Based Graph Composition

How to compose a complete automation graph for `set_graph` without guessing.
Three trust levels apply:

- **Structure (enforced):** the raw graph contract below is validated by the
  server on every `set_graph` plan. A payload that violates it never reaches
  the gateway.
- **Verified-live shapes:** node shapes observed in real, working automations
  exported from a live `v1.6.1` / `2.0.0` gateway on 2026-08-09 (16 rules,
  465 node instances across 19 types). Safe to compose with on the supported
  version pair.
- **Frontend-derived shapes:** ports and defaults observed only in frontend
  metadata for the remaining 7 types. Read a real instance on the target
  gateway (`mijia_read` with the automation `id`) before composing with
  these, or verify the applied result in the native UI.

No Xiaomi source code is copied; this catalog documents observed
interoperability structure only.

## Raw Graph Contract

A complete graph is `{ id, nodes, cfg }`:

- `id`: non-empty string; must equal `cfg.id`. The native UI uses
  epoch-millisecond digits (for example `"1770480155443"`); generate a fresh
  one for a new rule and check it does not collide with an existing
  automation.
- `cfg`: `{ id, enable: boolean, ... }`. The native UI also writes
  `uiType: "test"` and a `userData` object carrying the display name, tags,
  and canvas transform; preserve these fields verbatim when editing and
  provide at least `userData.name` when creating:

```json
{
  "enable": true,
  "id": "1770480155443",
  "uiType": "test",
  "userData": {
    "name": "rule display name",
    "tags": ["灯光"],
    "lastUpdateTime": 1775558835360,
    "transform": { "rotate": 0, "scale": 1, "x": 0, "y": 0 },
    "version": 0
  }
}
```

- `nodes`: array of nodes. Each node is:
  - `id`: unique within the graph, letters and digits only. The UI generates
    either 10 random alphanumerics or `<type><epoch-ms>`; both are valid.
  - `type`: one of the 26 allowlisted v1.6.1 types below.
  - `props`: object with the node's configuration values.
  - `inputs`: object whose keys declare the input port names (values are
    `null` placeholders in observed data).
  - `outputs`: object mapping each output port name to an array of
    connections, each written as `"destinationNodeId.destinationInput"`.
  - `cfg`: object with at least an integer `version` (0 and 1 observed).
    Common optional keys: `name` (display label), `pos` (`{x, y}` canvas
    position), `simplified` (collapsed card). Device-bound nodes also carry
    `urn` (device model string used for display).

Every connection must resolve to an existing node and one of its declared
input ports inside the same graph; dangling references are rejected. A
minimal valid wiring:

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

## Signal Kinds

The frontend distinguishes **event** signals (something happened) from
**status** signals (a condition currently holds). Connect like to like,
following the per-type notes below; mixed wiring can pass structural
validation yet render as a graph the native UI cannot edit sensibly.

## Comparison Operators

Observed `operator` values for `deviceInput`, `deviceGet`, `varChange`, and
`varGet`: `=`, `!=`, `<`, `<=`, `>`, and `include` (membership of the
observed value in the `v1` array). `v1` is the comparison operand: a scalar
matching `dtype`/`varType`, or an array when `operator` is `include`.

## Device Bindings

`did` (device id), `siid`/`piid` (MIoT service/property), `eiid` (event),
`aiid` (action), `dtype` (`boolean`/`int`/`float`/`number`/`string`), and
`urn` must come from `mijia_read devices` or from an existing graph that
already controls the target device. Never guess these values.

## Trigger Nodes (event sources, no inputs)

### `deviceInput` - verified-live (x69)

Fires when a device property satisfies a comparison, or when a device event
occurs.

- Property form: `props { did, siid, piid, dtype, operator, v1, preload? }`.
  `preload: true` also evaluates the current value when the rule loads.
- Event form: `props { did, siid, eiid, arguments: [] }`.
- Outputs: `output` (event).

### `varChange` - verified-live (x31)

Fires when a variable satisfies a comparison after changing.
`props { scope, id, varType, operator, v1, preload? }`. Outputs: `output`
(event).

### `alarmClock` - verified-live (x2)

Time-of-day or sun-position trigger. Observed sunset form:
`props { type: "sunset", isSunset, latitude, longitude, offset, filter: {} }`
with `cfg { happenType: "now", tempOffset }`. Outputs: `output` (event).
Clock-time forms exist but were not observed; read a real instance before
composing one.

### `onLoad` - verified-live (x1)

Fires once when the rule is enabled/loaded. No props. Outputs: `output`
(event). Typically drives a `loop` start.

### `deviceInputSetVar` - verified-live (x1)

On a device event, copies event arguments into variables.
`props { did, siid, eiid, arguments: [{ piid, dtype, scope, id }] }`.
Outputs: `output` (event).

## Condition And Query Nodes

### `deviceGet` - verified-live (x35)

When the input event fires, reads a device property and compares it.
`props { did, siid, piid, dtype, operator, v1 }`. Inputs: `input` (event).
Outputs: `output` (comparison true), `output2` (comparison false); both
carry the event onward.

### `varGet` - verified-live (x16)

Like `deviceGet` for a variable. `props { scope, id, varType, operator, v1 }`.
Inputs: `input` (event). Outputs: `output` (true), `output2` (false).

### `deviceGetSetVar` - frontend-derived

"Query device and assign": reads a device property into a variable when
triggered. Carries `cfg { urn }` and device/variable bindings similar to
`deviceInputSetVar`. Read a real instance before composing.

### `timeRange` - verified-live (x3)

Status source that is true between two times of day.
`props { start: {hour, minute, second}, end: {hour, minute, second},
filter: {}, mingTextShow: false }`. No inputs. Outputs: `output` (status).

### `logicAnd` - verified-live (x1)

Status AND. Inputs: `input0`, `input1` (status). Outputs: `output` (status).

### `logicOr` - frontend-derived

Status OR with extensible inputs (`input0`, `input1`, ...). Outputs:
`output` (status).

### `logicNot` - verified-live (x2)

Status inverter. Inputs: `input`. Outputs: `output` (status).

### `signalOr` - verified-live (x39)

Event merge: forwards any incoming event. Extensible inputs `input0` ...
`input5` observed. Outputs: `output` (event).

### `condition` - frontend-derived

"When / if / then": passes the trigger event through only while the status
input holds. Inputs: `trigger` (event), `condition` (status). Outputs:
`met`, `unmet` (event).

### `register` - frontend-derived

User-defined boolean state. Inputs: `setTrue`, `setFalse` (event). Outputs:
`output` (status).

## Timing And Flow-Control Nodes

All timing nodes keep the real duration in `props` in **milliseconds** and a
display pair in `cfg { unit, value }` (`unit`: `"s"` or `"min"` observed).
Keep both consistent, e.g. `props.timeout: 10000` with
`cfg { unit: "s", value: 10 }`.

### `delay` - verified-live (x6)

Forwards the event after `props.timeout` ms. Inputs: `input`. Outputs:
`output`.

### `loop` - verified-live (x3)

Emits an event every `props.interval` ms after `start` fires, until `stop`
fires. Inputs: `start`, `stop` (event). Outputs: `output` (event).

### `statusLast` - verified-live (x7)

Forwards only if the input signal persists for `props.timeout` ms
(debounce). Inputs: `input`. Outputs: `output`.

### `eventSequence` - frontend-derived

Fires when `input1` then `input2` occur within `props.timeout` ms
(`cfg { unit, value }` display). Inputs: `input1`, `input2` (event).
Outputs: `output` (event).

### `counter` - verified-live (x2)

Counts input events and fires when the count reaches `props.n`; `zero`
resets. Inputs: `input`, `zero` (event). Outputs: `output` (event).

### `onlyNTimes` - frontend-derived

Rate limiter: forwards at most `props.n` events until `zero` resets.
Inputs: `input`, `zero` (event). Outputs: `output` (event).

### `modeSwitch` - frontend-derived

Cycles to the next output on each input event (mode cycling). Inputs:
`input` (event). Outputs: extensible `output0`, `output1`, ... (event).

## Action Nodes

### `deviceOutput` - verified-live (x159)

Acts on a device when `trigger` fires; chains via `output`. Three observed
forms:

- Constant property write: `props { did, siid, piid, value }`.
- Action invocation: `props { did, siid, aiid, ins: [{ piid, value }] }`
  (`ins` may be empty; string values observed for TTS-style actions).
- Variable-driven property write:
  `props { did, siid, piid, dtype, scope, id, min, max, step }` - writes the
  variable's value clamped to `[min, max]` with `step`.

Inputs: `trigger` (event). Outputs: `output` (event, fires after acting).

### `varSetNumber` - verified-live (x36) and `varSetString` - verified-live (x9)

Assign a variable from a concatenation/expression of elements when `input`
fires. `props { scope, id, elements: [...] }` where each element is
`{ type: "const", value: "..." }` (values stored as strings even for
numbers) or `{ type: "var", scope, id }`. Inputs: `input` (event). Outputs:
`output` (event).

### `nop` - verified-live (x46)

Canvas text/annotation card; not part of signal flow.
`cfg { contents: [], background: "#80CAFF", ... }`, empty props, no
connected ports (an unused `output` key is present in observed data).

## Variables

- Scopes observed: `global`, and `R<ruleId>` for rule-local variables (the
  rule id prefixed with `R`).
- A variable referenced by any node must exist first: create it with the
  guarded `create_variable` operation (`type`: `number` or `string`).
- Variable ids observed use a `V` prefix plus random alphanumerics; any
  unique id is structurally valid.

## Composition Procedure

Composing a new graph is allowed only through this evidence-based procedure.

1. **Inventory:** `mijia_read` automations (summaries) and identify existing
   rules similar to the desired behavior.
2. **Observe:** for verified-live types, the shapes above are sufficient on
   the supported version pair; for frontend-derived types, read a real
   instance on the target gateway first, or create one example manually in
   the native UI and read it back.
3. **Compose from observations only:** reuse observed shapes verbatim,
   changing only the values that express the new behavior (device bindings,
   thresholds, wiring, variable references). Do not invent a `props` key,
   port name, or `cfg` field that neither this catalog nor the target
   gateway has shown.
4. **Prefer clone-and-modify:** when a similar rule exists, start from its
   complete graph and edit, rather than assembling from scratch.
5. **Stay consistent:** take every device binding from `mijia_read devices`
   or an existing graph; keep `props` durations (ms) consistent with
   `cfg { unit, value }`; create referenced variables first; set
   `cfg.userData.name` so the rule is identifiable in the native UI.
6. **Guarded write as always:** `mijia_plan_change` with the complete graph,
   review the diff, `mijia_create_backup`, exact user confirmation,
   `mijia_apply_change`, readback, and a behavior check in the native UI.

New rules should start with `enable: false` when the user wants to inspect
them in the native UI before activation.

## Recording Further Shapes

Record newly verified node shapes per firmware pair here so later
compositions can rely on them. Suggested format:

```text
### v1.6.1 / 2.0.0 - <type> (verified YYYY-MM-DD)
props: { ... }        # keys and value kinds, values redacted where private
inputs: [ ... ]       # port names
outputs: [ ... ]      # port names
cfg extras: { ... }
source: automation <id> read on the target gateway
```

The verified-live shapes above were recorded 2026-08-09 from a live backup
of a `v1.6.1` / `2.0.0` gateway; the frontend-derived entries are the next
candidates to verify.
