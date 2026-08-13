# MCP Tool Workflows

Reference for `mijia_read` filters, `mijia_plan_change` operation payloads, and
opaque token handling across the MijiaFlow tools.

## Read Filters

- `automations`: `id?: string`, `enabled?: boolean`, `includeNodes?: boolean`. An `id` read always returns the complete raw graph.
- `devices`: `id?: string`, `available?: boolean`.
- `variables`: `scope?: string`, `id?: string`.
- `logs`: `page?: non-negative integer`, `pages?: integer from 1 through 20`.
- `backups`: `from?: "fds"`.

Unknown filter keys fail validation and never reach the gateway.
An ordinary backup read can temporarily omit a newly completed cloud backup
because the gateway list is eventually consistent. `mijia_create_backup`
internally polls for and binds a new matching record before downloading it.

## Change Operations

- `set_graph`: complete `{id, nodes, cfg}`; require `cfg.id === id` and boolean `cfg.enable`. Each node requires a unique alphanumeric `id`, a known v1.6.1 `type`, object `props/inputs/outputs/cfg`, and integer `cfg.version`. Every output connection uses `destinationNodeId.destinationInput` and must resolve inside the graph. Compose new graphs only from node shapes observed on the target gateway; see [node-catalog.md](node-catalog.md).
- `delete_graph`: `{id}`.
- `set_graph_config`: `{id, cfg}`; require a complete config, `cfg.id === id`, and boolean `cfg.enable`.
- `set_graph_enabled`: `{id, enabled}`.
- `create_variable`: `{scope, id, type, value?, userData?}` where type is `number` or `string` and value matches it.
- `set_variable_value`: `{scope, id, value}` where value matches the existing `number` or `string` type and the baseline already contains a restorable value.
- `set_variable_config`: `{scope, id, userData}` where the baseline already contains restorable `userData`.
- `delete_variable`: `{scope, id}`.

All payload objects are closed schemas. Do not add arbitrary method names or extra fields.

## Confirmation Handling

Treat `planToken`, `backupReceipt`, `changeId`, and confirmation phrases as opaque and process-local. Pass them unchanged to the corresponding apply or rollback tool, but do not persist, edit, reuse across sessions, or substitute them. A server restart or `mijia_end_session` invalidates them.
