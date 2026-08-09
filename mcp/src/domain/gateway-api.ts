import { z } from "zod";
import { MijiaFlowError } from "../errors.js";
import type { GatewayRpc } from "../protocol/gateway-client.js";
import type { BackupDocument } from "./backup-codec.js";

const READ_METHODS = new Set([
  "getGraphList",
  "getGraph",
  "getDevList",
  "getLog",
  "getVarScopeList",
  "getVarList",
  "getBackupList",
  "getBackupProgress",
  "getBackupConfig",
  "generateBackup",
]);

const WRITE_METHODS = new Set([
  "setGraph",
  "deleteGraph",
  "changeGraphConfig",
  "createVar",
  "deleteVar",
  "setVarConfig",
  "setVarValue",
  "createBackup",
  "downloadBackup",
]);

const GRAPH_NODE_TYPES = [
  "deviceInput",
  "deviceOutput",
  "deviceGet",
  "alarmClock",
  "timeRange",
  "delay",
  "signalOr",
  "logicOr",
  "logicAnd",
  "logicNot",
  "condition",
  "loop",
  "onlyNTimes",
  "counter",
  "modeSwitch",
  "register",
  "eventSequence",
  "statusLast",
  "onLoad",
  "nop",
  "deviceInputSetVar",
  "deviceGetSetVar",
  "varChange",
  "varGet",
  "varSetNumber",
  "varSetString",
] as const;

const graphNodeSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9]+$/, "node id must contain only letters and numbers"),
  type: z.enum(GRAPH_NODE_TYPES),
  props: z.record(z.string(), z.unknown()),
  inputs: z.record(z.string().min(1), z.unknown()),
  outputs: z.record(z.string().min(1), z.array(z.string().min(1))),
  cfg: z.object({ version: z.number().int() }).passthrough(),
}).passthrough();

export const writeGraphConfigSchema = z.object({
  id: z.string().min(1),
  enable: z.boolean(),
}).passthrough();

export const writeRawGraphSchema = z.object({
  id: z.string().min(1),
  nodes: z.array(graphNodeSchema),
  cfg: writeGraphConfigSchema,
}).strict().superRefine((graph, context) => {
  if (graph.cfg.id !== graph.id) {
    context.addIssue({ code: "custom", path: ["cfg", "id"], message: "cfg.id must match id" });
  }
  const nodes = new Map<string, (typeof graph.nodes)[number]>();
  graph.nodes.forEach((node, index) => {
    if (nodes.has(node.id)) {
      context.addIssue({ code: "custom", path: ["nodes", index, "id"], message: `duplicate node id: ${node.id}` });
    } else {
      nodes.set(node.id, node);
    }
  });
  graph.nodes.forEach((node, nodeIndex) => {
    for (const [outputPort, connections] of Object.entries(node.outputs)) {
      connections.forEach((connection, connectionIndex) => {
        const segments = connection.split(".");
        const path = ["nodes", nodeIndex, "outputs", outputPort, connectionIndex] as const;
        if (segments.length !== 2 || !segments[0] || !segments[1]) {
          context.addIssue({
            code: "custom",
            path: [...path],
            message: "connection must be destinationNodeId.destinationInput",
          });
          return;
        }
        const [destinationId, destinationInput] = segments as [string, string];
        if (!/^[A-Za-z0-9]+$/.test(destinationId)) {
          context.addIssue({ code: "custom", path: [...path], message: "connection node id is invalid" });
          return;
        }
        const destination = nodes.get(destinationId);
        if (!destination) {
          context.addIssue({ code: "custom", path: [...path], message: `connection references missing node: ${destinationId}` });
          return;
        }
        if (!Object.hasOwn(destination.inputs, destinationInput)) {
          context.addIssue({
            code: "custom",
            path: [...path],
            message: `connection references missing input: ${connection}`,
          });
        }
      });
    }
  });
});

const gatewayGraphSchema = z.object({
  id: z.string().min(1),
  nodes: z.array(z.unknown()),
  cfg: z.record(z.string(), z.unknown()),
}).strict();

const backupRecordSchema = z.object({
  did: z.string().min(1),
  ts: z.union([z.string().min(1), z.number().finite()]),
  fileName: z.string().min(1),
}).passthrough();

const cloudBackupDocumentSchema = z.object({
  version: z.literal(2),
  rules: z.array(gatewayGraphSchema),
  variables: z.record(z.string(), z.record(z.string(), z.unknown())),
}).strict();

export type RawGraph = z.infer<typeof gatewayGraphSchema>;
export type ReadResource = "automations" | "devices" | "variables" | "logs" | "backups";

export interface CloudBackupResult {
  record: z.infer<typeof backupRecordSchema>;
  document: BackupDocument;
  binding: {
    preexistingRecords: number;
    newRecordIdentity: string;
  };
}

export interface GatewayStateSnapshot {
  automations: RawGraph[];
  variables: Record<string, Record<string, unknown>>;
  backupConfig: unknown;
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MijiaFlowError(message, "INVALID_GATEWAY_RESPONSE");
  }
  return value as Record<string, unknown>;
}

export class GatewayApi {
  constructor(readonly rpc: GatewayRpc) {}

  async invokeRead(method: string, params: unknown, timeoutMs = 5_000): Promise<unknown> {
    if (!READ_METHODS.has(method)) {
      throw new MijiaFlowError(`Gateway read method is not allowlisted: ${method}`, "METHOD_NOT_ALLOWED");
    }
    return this.rpc.call(method, params, timeoutMs);
  }

  async invokeWrite(method: string, params: unknown, timeoutMs = 5_000): Promise<unknown> {
    if (!WRITE_METHODS.has(method)) {
      throw new MijiaFlowError(`Gateway write method is not allowlisted: ${method}`, "METHOD_NOT_ALLOWED");
    }
    return this.rpc.call(method, params, timeoutMs);
  }

  async read(resource: ReadResource, filters: Record<string, unknown> = {}): Promise<unknown> {
    switch (resource) {
      case "automations":
        return this.#readAutomations(filters);
      case "devices":
        return this.#readDevices(filters);
      case "variables":
        return this.#readVariables(filters);
      case "logs":
        return this.#readLogs(filters);
      case "backups":
        return this.#readBackups(filters);
    }
  }

  async getAllGraphs(): Promise<RawGraph[]> {
    const list = await this.#graphConfigs();
    return Promise.all(list.map((cfg) => this.#graphFromConfig(cfg)));
  }

  async getGraph(id: string): Promise<RawGraph | null> {
    const cfg = (await this.#graphConfigs()).find((entry) => entry.id === id);
    return cfg ? this.#graphFromConfig(cfg) : null;
  }

  async getAllVariables(): Promise<Record<string, Record<string, unknown>>> {
    const response = objectRecord(await this.invokeRead("getVarScopeList", {}), "Invalid variable scope response");
    const scopes = z.array(z.string()).parse(response.scopes);
    const variables: Record<string, Record<string, unknown>> = {};
    for (const scope of scopes) {
      variables[scope] = objectRecord(
        await this.invokeRead("getVarList", { scope }),
        "Invalid variable list response",
      );
    }
    return variables;
  }

  async getVariable(scope: string, id: string): Promise<unknown | null> {
    const variables = objectRecord(
      await this.invokeRead("getVarList", { scope }),
      "Invalid variable list response",
    );
    return variables[id] ?? null;
  }

  async snapshot(): Promise<GatewayStateSnapshot> {
    const [automations, variables, backupConfig] = await Promise.all([
      this.getAllGraphs(),
      this.getAllVariables(),
      this.invokeRead("getBackupConfig", { from: "fds" }),
    ]);
    return { automations, variables, backupConfig };
  }

  async backupDocument(): Promise<BackupDocument> {
    const [rules, variables] = await Promise.all([this.getAllGraphs(), this.getAllVariables()]);
    return { version: 2, rules, variables };
  }

  async createCloudBackup(fileName: string, timeoutMs = 70_000): Promise<CloudBackupResult> {
    const before = await this.#backupList();
    const existingIdentities = new Set(before.map((record) => this.#backupRecordIdentity(record)));
    const progressId = await this.invokeWrite(
      "createBackup",
      { from: "fds", params: { fileName } },
      5_000,
    );
    if (!Number.isInteger(progressId)) {
      throw new MijiaFlowError("Cloud backup did not return a progress identifier", "INVALID_GATEWAY_RESPONSE");
    }
    await this.#waitForProgress(progressId as number, timeoutMs);
    const matching = await this.#waitForNewBackupRecord(
      fileName,
      existingIdentities,
      Math.min(timeoutMs, 30_000),
    );
    const document = await this.downloadCloudBackup(matching, timeoutMs);
    return {
      record: matching,
      document,
      binding: {
        preexistingRecords: before.length,
        newRecordIdentity: this.#backupRecordIdentity(matching),
      },
    };
  }

  async downloadCloudBackup(record: unknown, timeoutMs = 70_000): Promise<BackupDocument> {
    const matching = backupRecordSchema.parse(record);
    const params = {
      did: matching.did,
      ts: String(matching.ts),
      fileName: matching.fileName,
    };
    const downloadId = await this.invokeWrite("downloadBackup", { from: "fds", params }, 30_000);
    if (downloadId !== 0) {
      if (!Number.isInteger(downloadId)) {
        throw new MijiaFlowError("Cloud download returned an invalid progress identifier", "INVALID_GATEWAY_RESPONSE");
      }
      await this.#waitForProgress(downloadId as number, timeoutMs);
    }
    return cloudBackupDocumentSchema.parse(
      await this.invokeRead("generateBackup", { from: "fds", params }, 30_000),
    );
  }

  async #readAutomations(filters: Record<string, unknown>): Promise<unknown> {
    const parsed = z.object({
      id: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
      includeNodes: z.boolean().optional(),
    }).strict().parse(filters);
    const configs = await this.#graphConfigs();
    const selected = configs.filter((cfg) => {
      if (parsed.id && cfg.id !== parsed.id) return false;
      if (parsed.enabled !== undefined && cfg.enable !== parsed.enabled) return false;
      return true;
    });
    if (parsed.id) {
      return selected[0] ? this.#graphFromConfig(selected[0]) : null;
    }
    return parsed.includeNodes ? Promise.all(selected.map((cfg) => this.#graphFromConfig(cfg))) : selected;
  }

  async #readDevices(filters: Record<string, unknown>): Promise<unknown> {
    const parsed = z.object({ id: z.string().optional(), available: z.boolean().optional() }).strict().parse(filters);
    const response = objectRecord(await this.invokeRead("getDevList", {}, 10_000), "Invalid device response");
    const devices = objectRecord(response.devList, "Invalid device list");
    return Object.fromEntries(Object.entries(devices).filter(([id, value]) => {
      if (parsed.id && parsed.id !== id) return false;
      if (parsed.available !== undefined) {
        const device = objectRecord(value, "Invalid device entry");
        if (device.online !== parsed.available) return false;
      }
      return true;
    }));
  }

  async #readVariables(filters: Record<string, unknown>): Promise<unknown> {
    const parsed = z.object({ scope: z.string().optional(), id: z.string().optional() }).strict().parse(filters);
    const all = await this.getAllVariables();
    const scopes = parsed.scope ? [parsed.scope] : Object.keys(all);
    return Object.fromEntries(scopes.filter((scope) => all[scope]).map((scope) => {
      const values = all[scope] ?? {};
      return [scope, parsed.id ? { [parsed.id]: values[parsed.id] } : values];
    }));
  }

  async #readLogs(filters: Record<string, unknown>): Promise<unknown> {
    const parsed = z.object({ page: z.number().int().min(0).default(0), pages: z.number().int().min(1).max(20).default(1) })
      .strict().parse(filters);
    const pages: Array<{ page: number; content: string }> = [];
    for (let page = parsed.page; page < parsed.page + parsed.pages; page += 1) {
      const content = z.string().parse(await this.invokeRead("getLog", { num: page }));
      pages.push({ page, content });
      if (content.length === 0) break;
    }
    return pages;
  }

  async #readBackups(filters: Record<string, unknown>): Promise<unknown> {
    z.object({ from: z.literal("fds").default("fds") }).strict().parse(filters);
    return this.#backupList();
  }

  async #graphConfigs(): Promise<Array<Record<string, unknown> & { id: string }>> {
    const result = z.array(z.record(z.string(), z.unknown())).parse(await this.invokeRead("getGraphList", {}));
    return result.map((cfg) => ({ ...cfg, id: z.string().min(1).parse(cfg.id) }));
  }

  async #graphFromConfig(cfg: Record<string, unknown> & { id: string }): Promise<RawGraph> {
    const result = objectRecord(await this.invokeRead("getGraph", { id: cfg.id }), "Invalid graph response");
    return gatewayGraphSchema.parse({ id: cfg.id, cfg, nodes: result.nodes });
  }

  async #backupList(): Promise<Array<z.infer<typeof backupRecordSchema>>> {
    return z.array(backupRecordSchema).parse(
      await this.invokeRead("getBackupList", { from: "fds" }, 30_000),
    );
  }

  async #waitForNewBackupRecord(
    fileName: string,
    existingIdentities: Set<string>,
    timeoutMs: number,
  ): Promise<z.infer<typeof backupRecordSchema>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const matching = (await this.#backupList())
        .filter((item) => item.fileName === fileName && !existingIdentities.has(this.#backupRecordIdentity(item)))
        .sort((left, right) => Number(right.ts ?? 0) - Number(left.ts ?? 0))[0];
      if (matching) return matching;

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, remaining)));
    }
    throw new MijiaFlowError("Cloud backup completed but no new matching record was listed", "BACKUP_NOT_FOUND");
  }

  #backupRecordIdentity(record: z.infer<typeof backupRecordSchema>): string {
    return JSON.stringify([record.did, String(record.ts), record.fileName]);
  }

  async #waitForProgress(progressId: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const progress = objectRecord(
        await this.invokeRead("getBackupProgress", { from: "fds", params: { progress_id: progressId } }),
        "Invalid backup progress response",
      );
      if (progress.progress === 100) return;
      if (typeof progress.code === "number") {
        throw new MijiaFlowError(
          typeof progress.message === "string" ? progress.message : "Gateway backup failed",
          "BACKUP_FAILED",
          { gatewayCode: progress.code },
        );
      }
      if (typeof progress.progress !== "number") {
        throw new MijiaFlowError("Gateway backup progress is invalid", "INVALID_GATEWAY_RESPONSE");
      }
    }
    throw new MijiaFlowError("Gateway backup operation timed out", "BACKUP_TIMEOUT");
  }
}
