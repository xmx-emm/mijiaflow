import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeBackup, encodeBackup, type BackupDocument } from "../src/domain/backup-codec.js";
import type { ProbeResult } from "../src/domain/compatibility.js";
import {
  GatewayApi,
  type CloudBackupResult,
  type GatewayStateSnapshot,
  type RawGraph,
} from "../src/domain/gateway-api.js";
import { TransactionManager } from "../src/domain/transaction-manager.js";
import type { GatewayRpc } from "../src/protocol/gateway-client.js";
import type { SessionContext } from "../src/session/session-manager.js";

const automation: RawGraph = {
  id: "rule-1",
  cfg: { id: "rule-1", enable: true },
  nodes: [],
};

const document: BackupDocument = {
  version: 2,
  rules: [automation],
  variables: { global: { temperature: { type: "number", value: 21 } } },
};

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

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Mijia local backup codec", () => {
  it("appends and verifies a SHA-256 receipt over the compressed payload", () => {
    const encoded = encodeBackup(document);
    expect(encoded.length).toBeGreaterThan(32);
    expect(decodeBackup(encoded).document).toEqual(document);
  });

  it("rejects a modified digest or payload", () => {
    const encoded = encodeBackup(document);
    encoded[5]! ^= 1;
    expect(() => decodeBackup(encoded)).toThrow(/digest/);
  });

  it("creates cloud:false backups from backupDocument without reading backup settings", async () => {
    const calls: string[] = [];
    const rpc: GatewayRpc = {
      async call(method: string, params: unknown): Promise<unknown> {
        calls.push(method);
        const input = params as Record<string, unknown>;
        switch (method) {
          case "getGraphList":
            return document.rules.map((rule) => rule.cfg);
          case "getGraph":
            return { nodes: document.rules.find((rule) => rule.id === input.id)?.nodes ?? [] };
          case "getVarScopeList":
            return { scopes: Object.keys(document.variables) };
          case "getVarList":
            return document.variables[input.scope as string] ?? {};
          case "getBackupConfig":
            throw new Error("local backup must not read backup config");
          default:
            throw new Error(`Unexpected method ${method}`);
        }
      },
    };
    const directory = await mkdtemp(join(tmpdir(), "mijiaflow-backup-test-"));
    directories.push(directory);
    const context: SessionContext = { id: "local-backup", probe, api: new GatewayApi(rpc) };
    const result = await new TransactionManager(join(directory, "rollback"))
      .createBackup(context, "local.bak", directory, false);
    expect(result.cloud).toEqual({ status: "not-requested" });
    expect(calls).not.toContain("getBackupConfig");
  });

  it("preserves unfamiliar graph nodes on the read-only backup path", async () => {
    const futureGraph: RawGraph = {
      id: "future-rule",
      cfg: { id: "future-rule", enable: true },
      nodes: [{ id: "future-node", type: "futureNode", wire: ["opaque"] }],
    };
    const rpc: GatewayRpc = {
      async call(method: string, params: unknown): Promise<unknown> {
        const input = params as Record<string, unknown>;
        switch (method) {
          case "getGraphList":
            return [futureGraph.cfg];
          case "getGraph":
            return input.id === futureGraph.id ? { nodes: futureGraph.nodes } : { nodes: [] };
          case "getVarScopeList":
            return { scopes: [] };
          default:
            throw new Error(`Unexpected method ${method}`);
        }
      },
    };
    await expect(new GatewayApi(rpc).backupDocument()).resolves.toEqual({
      version: 2,
      rules: [futureGraph],
      variables: {},
    });
  });

  it("downloads only the newly created cloud record when a filename already exists", async () => {
    let listReads = 0;
    let downloadedDid: unknown;
    const oldRecord = { did: "old", ts: "1", fileName: "same.bak" };
    const newRecord = { did: "new", ts: "2", fileName: "same.bak" };
    const rpc: GatewayRpc = {
      async call(method: string, params: unknown): Promise<unknown> {
        const input = params as { params?: Record<string, unknown> };
        switch (method) {
          case "getBackupList":
            listReads += 1;
            return listReads === 1 ? [oldRecord] : [oldRecord, newRecord];
          case "createBackup":
            return 7;
          case "getBackupProgress":
            return { progress: 100 };
          case "downloadBackup":
            downloadedDid = input.params?.did;
            return 0;
          case "generateBackup":
            return document;
          default:
            throw new Error(`Unexpected method ${method}`);
        }
      },
    };
    const result = await new GatewayApi(rpc).createCloudBackup("same.bak");
    expect(result.record.did).toBe("new");
    expect(result.binding).toMatchObject({ preexistingRecords: 1 });
    expect(downloadedDid).toBe("new");
  });

  it("waits for a completed cloud backup to appear in the eventually consistent list", async () => {
    let listReads = 0;
    let creates = 0;
    let downloadedDid: unknown;
    const newRecord = { did: "eventual", ts: "3", fileName: "eventual.bak" };
    const rpc: GatewayRpc = {
      async call(method: string, params: unknown): Promise<unknown> {
        const input = params as { params?: Record<string, unknown> };
        switch (method) {
          case "getBackupList":
            listReads += 1;
            return listReads < 3 ? [] : [newRecord];
          case "createBackup":
            creates += 1;
            return 8;
          case "getBackupProgress":
            return { progress: 100 };
          case "downloadBackup":
            downloadedDid = input.params?.did;
            return 0;
          case "generateBackup":
            return document;
          default:
            throw new Error(`Unexpected method ${method}`);
        }
      },
    };
    await expect(new GatewayApi(rpc).createCloudBackup("eventual.bak", 5_000)).resolves.toMatchObject({
      record: newRecord,
    });
    expect(creates).toBe(1);
    expect(listReads).toBe(3);
    expect(downloadedDid).toBe("eventual");
  });

  it("rejects a downloaded cloud backup whose content is not bound to the pre-backup snapshot", async () => {
    const snapshot: GatewayStateSnapshot = {
      automations: [automation],
      variables: document.variables,
      backupConfig: { autoBackup: false, autoBackupLimit: 25 },
    };
    const mismatched: BackupDocument = {
      ...document,
      variables: { global: { temperature: { type: "number", value: 99 } } },
    };
    class MismatchedCloudApi extends GatewayApi {
      constructor() {
        super({ async call(): Promise<never> { throw new Error("Unexpected RPC call"); } });
      }

      override async snapshot(): Promise<GatewayStateSnapshot> {
        return structuredClone(snapshot);
      }

      override async createCloudBackup(): Promise<CloudBackupResult> {
        return {
          record: { did: "new", ts: "2", fileName: "bound.bak" },
          document: structuredClone(mismatched),
          binding: { preexistingRecords: 1, newRecordIdentity: "new-record" },
        };
      }
    }
    const directory = await mkdtemp(join(tmpdir(), "mijiaflow-cloud-test-"));
    directories.push(directory);
    const context: SessionContext = { id: "cloud-backup", probe, api: new MismatchedCloudApi() };
    await expect(new TransactionManager(join(directory, "rollback"))
      .createBackup(context, "bound.bak", directory, true))
      .rejects.toMatchObject({ code: "CLOUD_BACKUP_CONTENT_MISMATCH" });
  });
});
