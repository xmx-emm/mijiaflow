import { z } from "zod";
import { MijiaFlowError } from "../errors.js";
import {
  writeGraphConfigSchema,
  writeRawGraphSchema,
  type GatewayApi,
  type RawGraph,
} from "./gateway-api.js";

const operationSchemas = {
  set_graph: writeRawGraphSchema,
  delete_graph: z.object({ id: z.string().min(1) }).strict(),
  set_graph_config: z.object({
    id: z.string().min(1),
    cfg: writeGraphConfigSchema,
  }).strict().superRefine((value, context) => {
    if (value.cfg.id !== value.id) {
      context.addIssue({ code: "custom", path: ["cfg", "id"], message: "cfg.id must match id" });
    }
  }),
  set_graph_enabled: z.object({ id: z.string().min(1), enabled: z.boolean() }).strict(),
  create_variable: z.object({
    scope: z.string().min(1),
    id: z.string().min(1),
    type: z.enum(["number", "string"]),
    value: z.union([z.number().finite(), z.string()]).optional(),
    userData: z.unknown().optional(),
  }).strict().superRefine((value, context) => {
    if (value.value !== undefined && typeof value.value !== value.type) {
      context.addIssue({ code: "custom", path: ["value"], message: `value must be a ${value.type}` });
    }
  }),
  set_variable_value: z.object({
    scope: z.string().min(1),
    id: z.string().min(1),
    value: z.union([z.number().finite(), z.string()]),
  }).strict(),
  set_variable_config: z.object({
    scope: z.string().min(1),
    id: z.string().min(1),
    userData: z.unknown(),
  }).strict(),
  delete_variable: z.object({ scope: z.string().min(1), id: z.string().min(1) }).strict(),
} as const;

export type OperationName = keyof typeof operationSchemas;

export interface PreparedOperation {
  name: OperationName;
  family: "graph" | "variable";
  objectKey: string;
  objectId: string;
  scope?: string;
  payload: Record<string, unknown>;
  baseline: unknown;
  target: unknown;
  summary: string;
}

function variableProjection(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of ["type", "value", "userData"] as const) {
    if (source[key] !== undefined) projected[key] = source[key];
  }
  return projected;
}

export async function prepareOperation(
  api: GatewayApi,
  operation: string,
  rawPayload: unknown,
): Promise<PreparedOperation> {
  if (!Object.hasOwn(operationSchemas, operation)) {
    throw new MijiaFlowError(`Operation is not allowlisted: ${operation}`, "OPERATION_NOT_ALLOWED");
  }
  const name = operation as OperationName;
  const payload = operationSchemas[name].parse(rawPayload) as Record<string, unknown>;
  if (name.includes("graph")) {
    const id = payload.id as string;
    const baseline = await api.getGraph(id);
    if ((name === "delete_graph" || name === "set_graph_config" || name === "set_graph_enabled") && !baseline) {
      throw new MijiaFlowError(`Automation ${id} does not exist`, "OBJECT_NOT_FOUND");
    }
    let target: RawGraph | null;
    switch (name) {
      case "set_graph":
        target = payload as unknown as RawGraph;
        break;
      case "delete_graph":
        target = null;
        break;
      case "set_graph_config":
        target = { ...baseline!, cfg: payload.cfg as Record<string, unknown> };
        break;
      case "set_graph_enabled":
        target = { ...baseline!, cfg: { ...baseline!.cfg, enable: payload.enabled } };
        break;
      default:
        throw new MijiaFlowError("Invalid graph operation", "OPERATION_NOT_ALLOWED");
    }
    return {
      name,
      family: "graph",
      objectKey: `graph:${id}`,
      objectId: id,
      payload,
      baseline,
      target,
      summary: `${name} on automation ${id}`,
    };
  }

  const scope = payload.scope as string;
  const id = payload.id as string;
  const baseline = variableProjection(await api.getVariable(scope, id));
  if (name === "create_variable" && baseline) {
    throw new MijiaFlowError(`Variable ${scope}/${id} already exists`, "OBJECT_ALREADY_EXISTS");
  }
  if (name !== "create_variable" && !baseline) {
    throw new MijiaFlowError(`Variable ${scope}/${id} does not exist`, "OBJECT_NOT_FOUND");
  }
  let target: Record<string, unknown> | null;
  switch (name) {
    case "create_variable":
      target = variableProjection(payload);
      break;
    case "set_variable_value":
      if (baseline!.type !== "number" && baseline!.type !== "string") {
        throw new MijiaFlowError(
          `Variable ${scope}/${id} has an unsupported baseline type`,
          "UNSUPPORTED_VARIABLE_TYPE",
        );
      }
      if (typeof payload.value !== baseline!.type) {
        throw new MijiaFlowError(
          `Variable ${scope}/${id} requires a ${baseline!.type} value`,
          "VARIABLE_TYPE_MISMATCH",
        );
      }
      if (!Object.hasOwn(baseline!, "value")) {
        throw new MijiaFlowError(
          `Variable ${scope}/${id} has no restorable baseline value`,
          "NON_REVERSIBLE_OPERATION",
        );
      }
      target = { ...baseline!, value: payload.value };
      break;
    case "set_variable_config":
      if (!Object.hasOwn(baseline!, "userData")) {
        throw new MijiaFlowError(
          `Variable ${scope}/${id} has no restorable baseline configuration`,
          "NON_REVERSIBLE_OPERATION",
        );
      }
      target = { ...baseline!, userData: payload.userData };
      break;
    case "delete_variable":
      target = null;
      break;
    default:
      throw new MijiaFlowError("Invalid variable operation", "OPERATION_NOT_ALLOWED");
  }
  return {
    name,
    family: "variable",
    objectKey: `variable:${scope}:${id}`,
    objectId: id,
    scope,
    payload,
    baseline,
    target,
    summary: `${name} on variable ${scope}/${id}`,
  };
}

export async function readPreparedObject(api: GatewayApi, prepared: PreparedOperation): Promise<unknown> {
  return prepared.family === "graph"
    ? api.getGraph(prepared.objectId)
    : variableProjection(await api.getVariable(prepared.scope!, prepared.objectId));
}

export async function applyPreparedOperation(api: GatewayApi, prepared: PreparedOperation): Promise<void> {
  const payload = prepared.payload;
  switch (prepared.name) {
    case "set_graph":
      await api.invokeWrite("setGraph", payload);
      return;
    case "delete_graph":
      await api.invokeWrite("deleteGraph", { id: prepared.objectId });
      return;
    case "set_graph_config":
      await api.invokeWrite("changeGraphConfig", payload.cfg);
      return;
    case "set_graph_enabled":
      await api.invokeWrite("changeGraphConfig", (prepared.target as RawGraph).cfg);
      return;
    case "create_variable":
      await api.invokeWrite("createVar", payload);
      return;
    case "set_variable_value":
      await api.invokeWrite("setVarValue", payload);
      return;
    case "set_variable_config":
      await api.invokeWrite("setVarConfig", payload);
      return;
    case "delete_variable":
      await api.invokeWrite("deleteVar", { scope: prepared.scope, id: prepared.objectId });
  }
}

export async function restorePreparedBaseline(api: GatewayApi, prepared: PreparedOperation): Promise<void> {
  if (prepared.family === "graph") {
    if (prepared.baseline === null) {
      const current = await api.getGraph(prepared.objectId);
      if (current) await api.invokeWrite("deleteGraph", { id: prepared.objectId });
    } else if (prepared.name === "set_graph_config" || prepared.name === "set_graph_enabled") {
      await api.invokeWrite("changeGraphConfig", (prepared.baseline as RawGraph).cfg);
    } else {
      await api.invokeWrite("setGraph", prepared.baseline);
    }
    return;
  }
  const scope = prepared.scope!;
  const current = variableProjection(await api.getVariable(scope, prepared.objectId));
  if (prepared.baseline === null) {
    if (current) await api.invokeWrite("deleteVar", { scope, id: prepared.objectId });
    return;
  }
  const baseline = prepared.baseline as Record<string, unknown>;
  if (!current) {
    await api.invokeWrite("createVar", { scope, id: prepared.objectId, ...baseline });
    return;
  }
  if (Object.hasOwn(baseline, "userData")) {
    await api.invokeWrite("setVarConfig", { scope, id: prepared.objectId, userData: baseline.userData });
  }
  if (Object.hasOwn(baseline, "value")) {
    await api.invokeWrite("setVarValue", { scope, id: prepared.objectId, value: baseline.value });
  }
}

export function objectFromBackup(
  document: {
    rules: Array<{ id: string; cfg: Record<string, unknown>; nodes: unknown[] }>;
    variables: Record<string, Record<string, unknown>>;
  },
  prepared: PreparedOperation,
): unknown {
  if (prepared.family === "graph") {
    const graph = document.rules.find((rule) => rule.id === prepared.objectId);
    return graph ?? null;
  }
  return variableProjection(document.variables[prepared.scope!]?.[prepared.objectId]);
}
