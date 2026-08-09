import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProbeResult } from "../src/domain/compatibility.js";
import { GatewayApi, type RawGraph } from "../src/domain/gateway-api.js";
import { TransactionManager } from "../src/domain/transaction-manager.js";
import type { GatewayRpc } from "../src/protocol/gateway-client.js";
import type { SessionContext } from "../src/session/session-manager.js";

class MemoryGateway implements GatewayRpc {
  graphs: RawGraph[] = [{
    id: "rule-1",
    cfg: { id: "rule-1", enable: true, userData: { name: "Hallway" } },
    nodes: [{ id: "node1", type: "nop", props: {}, inputs: {}, outputs: {}, cfg: { version: 1 } }],
  }];
  variables: Record<string, Record<string, unknown>> = {
    global: {
      count: { type: "number", value: 1, userData: {} },
      label: { type: "string", value: "ready", userData: {} },
      unset: { type: "number" },
      unconfigured: { type: "string", value: "ready" },
    },
  };
  writes = 0;
  onVariableScopeRead: (() => void) | undefined;
  onGraphConfigWrite: (() => Promise<void>) | undefined;
  corruptGraphConfigWrites = false;
  ignoreSetGraphWrites = false;

  async call(method: string, params: unknown): Promise<unknown> {
    const input = params as Record<string, unknown>;
    switch (method) {
      case "getGraphList":
        return this.graphs.map((graph) => graph.cfg);
      case "getGraph":
        return { nodes: this.graphs.find((graph) => graph.id === input.id)?.nodes ?? [] };
      case "getVarScopeList":
        this.onVariableScopeRead?.();
        return { scopes: Object.keys(this.variables) };
      case "getVarList":
        return this.variables[input.scope as string] ?? {};
      case "getBackupConfig":
        return { autoBackup: false, autoBackupLimit: 25 };
      case "changeGraphConfig": {
        this.writes += 1;
        await this.onGraphConfigWrite?.();
        const id = input.id as string;
        const graph = this.graphs.find((entry) => entry.id === id);
        if (graph) {
          graph.cfg = this.corruptGraphConfigWrites
            ? { ...structuredClone(input), enable: "corrupt" }
            : structuredClone(input);
        }
        return {};
      }
      case "setGraph": {
        this.writes += 1;
        if (this.ignoreSetGraphWrites) return {};
        const graph = structuredClone(input) as RawGraph;
        const index = this.graphs.findIndex((entry) => entry.id === graph.id);
        if (index >= 0) this.graphs[index] = graph;
        else this.graphs.push(graph);
        return {};
      }
      case "deleteGraph":
        this.writes += 1;
        this.graphs = this.graphs.filter((graph) => graph.id !== input.id);
        return {};
      case "createVar": {
        this.writes += 1;
        const { scope, id, ...value } = input;
        (this.variables[scope as string] ??= {})[id as string] = value;
        return {};
      }
      case "setVarValue": {
        this.writes += 1;
        const variable = this.variables[input.scope as string]?.[input.id as string] as Record<string, unknown>;
        variable.value = input.value;
        return {};
      }
      case "setVarConfig": {
        this.writes += 1;
        const variable = this.variables[input.scope as string]?.[input.id as string] as Record<string, unknown>;
        variable.userData = input.userData;
        return {};
      }
      case "deleteVar":
        this.writes += 1;
        delete this.variables[input.scope as string]?.[input.id as string];
        return {};
      default:
        throw new Error(`Unexpected method ${method}`);
    }
  }
}

const probe: ProbeResult = {
  baseUrl: "http://127.0.0.1/",
  websocketUrl: "ws://127.0.0.1/centrallinkws/",
  frontendVersion: "v1.6.1",
  protocolVersion: "2.0.0",
  buildTag: "test",
  mode: "read-write",
  capabilities: ["read", "transactional-write"],
  writeDisabledReasons: [],
};

const directories: string[] = [];

async function fixture(): Promise<{
  gateway: MemoryGateway;
  context: SessionContext;
  transactions: TransactionManager;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mijiaflow-test-"));
  directories.push(directory);
  const gateway = new MemoryGateway();
  return {
    gateway,
    context: { id: "session-1", probe, api: new GatewayApi(gateway) },
    transactions: new TransactionManager(join(directory, "rollback")),
    directory,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("transactional gateway writes", () => {
  it("requires a verified post-plan backup, applies, verifies, and rolls back", async () => {
    const { gateway, context, transactions, directory } = await fixture();
    const plan = await transactions.plan(context, "set_graph_enabled", { id: "rule-1", enabled: false });
    const backup = await transactions.createBackup(context, "baseline.bak", directory, false);
    const applied = await transactions.apply(
      context,
      plan.planToken as string,
      backup.backupReceipt as string,
      plan.confirmation as string,
    );
    expect(gateway.graphs[0]?.cfg.enable).toBe(false);
    expect(applied.status).toBe("applied-and-verified");

    const rolledBack = await transactions.rollback(
      context,
      applied.changeId as string,
      applied.rollbackConfirmation as string,
    );
    expect(rolledBack.status).toBe("rolled-back-and-verified");
    expect(gateway.graphs[0]?.cfg.enable).toBe(true);
  });

  it("detects concurrent baseline changes before issuing a write", async () => {
    const { gateway, context, transactions, directory } = await fixture();
    const plan = await transactions.plan(context, "delete_graph", { id: "rule-1" });
    const backup = await transactions.createBackup(context, "baseline.bak", directory, false);
    gateway.graphs[0]!.cfg = { ...gateway.graphs[0]!.cfg, userData: { name: "Changed elsewhere" } };
    await expect(transactions.apply(
      context,
      plan.planToken as string,
      backup.backupReceipt as string,
      plan.confirmation as string,
    )).rejects.toMatchObject({ code: "CONCURRENT_CHANGE" });
    expect(gateway.writes).toBe(0);
  });

  it("rejects partial raw graphs and mismatched config identifiers", async () => {
    const { context, transactions } = await fixture();
    await expect(transactions.plan(context, "set_graph", {
      id: "rule-1",
      nodes: [],
      cfg: { id: "different-rule", enable: true },
    })).rejects.toThrow(/cfg.id must match id/);
  });

  it("validates v1.6.1 nodes and connection destinations before planning", async () => {
    const { context, transactions } = await fixture();
    await expect(transactions.plan(context, "set_graph", {
      id: "rule-1",
      cfg: { id: "rule-1", enable: true },
      nodes: [{ id: "node-1", type: "unknown", props: {}, inputs: {}, outputs: {}, cfg: {} }],
    })).rejects.toThrow();

    await expect(transactions.plan(context, "set_graph", {
      id: "rule-1",
      cfg: { id: "rule-1" },
      nodes: [],
    })).rejects.toThrow();

    await expect(transactions.plan(context, "set_graph", {
      id: "rule-1",
      cfg: { id: "rule-1", enable: true },
      nodes: [
        {
          id: "source1",
          type: "onLoad",
          props: {},
          inputs: {},
          outputs: { output: ["target1.missing"] },
          cfg: { version: 1 },
        },
        {
          id: "target1",
          type: "nop",
          props: {},
          inputs: { input: {} },
          outputs: {},
          cfg: { version: 1 },
        },
      ],
    })).rejects.toThrow(/missing input/);

    await expect(transactions.plan(context, "set_graph", {
      id: "rule-1",
      cfg: { id: "rule-1", enable: true },
      nodes: [
        {
          id: "source1",
          type: "onLoad",
          props: {},
          inputs: {},
          outputs: { output: ["target1.input"] },
          cfg: { version: 1 },
        },
        {
          id: "target1",
          type: "nop",
          props: {},
          inputs: { input: {} },
          outputs: {},
          cfg: { version: 1 },
        },
      ],
    })).resolves.toMatchObject({ operation: "set_graph" });
  });

  it("validates variable values against the retained baseline type", async () => {
    const { context, transactions } = await fixture();
    await expect(transactions.plan(context, "set_variable_value", {
      scope: "global",
      id: "count",
      value: "2",
    })).rejects.toMatchObject({ code: "VARIABLE_TYPE_MISMATCH" });
    await expect(transactions.plan(context, "set_variable_value", {
      scope: "global",
      id: "label",
      value: 2,
    })).rejects.toMatchObject({ code: "VARIABLE_TYPE_MISMATCH" });
    await expect(transactions.plan(context, "set_variable_value", {
      scope: "global",
      id: "count",
      value: 2,
    })).resolves.toMatchObject({ operation: "set_variable_value" });
    await expect(transactions.plan(context, "set_variable_value", {
      scope: "global",
      id: "unset",
      value: 2,
    })).rejects.toMatchObject({ code: "NON_REVERSIBLE_OPERATION" });
    await expect(transactions.plan(context, "set_variable_config", {
      scope: "global",
      id: "unconfigured",
      userData: {},
    })).rejects.toMatchObject({ code: "NON_REVERSIBLE_OPERATION" });
  });

  it("rechecks for concurrent drift after the rollback backup and retains the change", async () => {
    const { gateway, context, transactions, directory } = await fixture();
    const plan = await transactions.plan(context, "set_graph_enabled", { id: "rule-1", enabled: false });
    const backup = await transactions.createBackup(context, "baseline.bak", directory, false);
    const applied = await transactions.apply(
      context,
      plan.planToken as string,
      backup.backupReceipt as string,
      plan.confirmation as string,
    );
    gateway.onVariableScopeRead = () => {
      gateway.onVariableScopeRead = undefined;
      gateway.graphs[0]!.cfg = { ...gateway.graphs[0]!.cfg, userData: { name: "Concurrent edit" } };
    };
    await expect(transactions.rollback(
      context,
      applied.changeId as string,
      applied.rollbackConfirmation as string,
    )).rejects.toMatchObject({ code: "CONCURRENT_CHANGE" });

    gateway.graphs[0]!.cfg = { id: "rule-1", enable: false, userData: { name: "Hallway" } };
    await expect(transactions.rollback(
      context,
      applied.changeId as string,
      applied.rollbackConfirmation as string,
    )).resolves.toMatchObject({ status: "rolled-back-and-verified" });
  });

  it("returns a guarded recovery change when apply compensation cannot be verified", async () => {
    const { gateway, context, transactions, directory } = await fixture();
    const plan = await transactions.plan(context, "set_graph_enabled", { id: "rule-1", enabled: false });
    const backup = await transactions.createBackup(context, "baseline.bak", directory, false);
    gateway.corruptGraphConfigWrites = true;
    gateway.ignoreSetGraphWrites = true;

    let failure: unknown;
    try {
      await transactions.apply(
        context,
        plan.planToken as string,
        backup.backupReceipt as string,
        plan.confirmation as string,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "WRITE_FAILED",
      details: { restored: false, recoveryAvailable: true },
    });
    const recovery = (failure as { details: { recovery: Record<string, unknown> } }).details.recovery;

    gateway.corruptGraphConfigWrites = false;
    gateway.ignoreSetGraphWrites = false;
    await expect(transactions.rollback(
      context,
      recovery.changeId as string,
      recovery.rollbackConfirmation as string,
    )).resolves.toMatchObject({ status: "rolled-back-and-verified" });
    expect(gateway.graphs[0]?.cfg.enable).toBe(true);
  });

  it("does not unlock an active write when transaction state is cleared", async () => {
    const { gateway, context, transactions, directory } = await fixture();
    const firstPlan = await transactions.plan(context, "set_graph_enabled", { id: "rule-1", enabled: false });
    const firstBackup = await transactions.createBackup(context, "first.bak", directory, false);
    let signalStarted!: () => void;
    let releaseWrite!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    gateway.onGraphConfigWrite = async () => {
      signalStarted();
      await gate;
    };

    const firstApply = transactions.apply(
      context,
      firstPlan.planToken as string,
      firstBackup.backupReceipt as string,
      firstPlan.confirmation as string,
    );
    await started;
    transactions.clear();
    const secondPlan = await transactions.plan(context, "set_variable_value", {
      scope: "global",
      id: "count",
      value: 2,
    });
    const secondBackup = await transactions.createBackup(context, "second.bak", directory, false);
    await expect(transactions.apply(
      context,
      secondPlan.planToken as string,
      secondBackup.backupReceipt as string,
      secondPlan.confirmation as string,
    )).rejects.toMatchObject({ code: "WRITE_IN_PROGRESS" });

    gateway.onGraphConfigWrite = undefined;
    releaseWrite();
    await expect(firstApply).resolves.toMatchObject({ status: "applied-and-verified" });
  });

  it("requires the exact one-time confirmation phrase", async () => {
    const { context, transactions, directory } = await fixture();
    const plan = await transactions.plan(context, "delete_graph", { id: "rule-1" });
    const backup = await transactions.createBackup(context, "baseline.bak", directory, false);
    await expect(transactions.apply(
      context,
      plan.planToken as string,
      backup.backupReceipt as string,
      "APPLY MIJIAFLOW WRONG",
    )).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
  });
});
