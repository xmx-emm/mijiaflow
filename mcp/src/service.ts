import { probeGateway } from "./domain/compatibility.js";
import type { ReadResource } from "./domain/gateway-api.js";
import { TransactionManager } from "./domain/transaction-manager.js";
import { SessionManager } from "./session/session-manager.js";
import { AsyncMutex } from "./util/async-mutex.js";
import { asMijiaFlowError } from "./errors.js";
import type { WorkbenchDiffEntry, WorkbenchOperation, WorkbenchProgress, WorkbenchSnapshot } from "./workbench.js";

const SECRET_KEYS = new Set([
  "passcode", "planToken", "backupReceipt", "confirmation", "rollbackConfirmation",
  "payload", "path", "record", "recordBinding", "deviceId", "deviceIds", "value",
]);

function safeValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEYS.has(key)) return "[已隐藏]";
  if (typeof value === "string") return "[已隐藏]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([childKey, child]) => [childKey, safeValue(child, childKey)]));
  }
  return value;
}

function safeDiff(diff: WorkbenchProgress["diff"]): WorkbenchDiffEntry[] | undefined {
  if (!diff) return undefined;
  return diff.slice(0, 100).map((entry) => ({
    path: entry.path,
    ...(entry.before !== undefined ? { before: safeValue(entry.before) } : {}),
    ...(entry.after !== undefined ? { after: safeValue(entry.after) } : {}),
  }));
}

export class MijiaFlowService {
  readonly #sessions = new SessionManager(() => this.#workbenchSnapshot());
  readonly #transactions = new TransactionManager((progress) => this.#updateOperation(progress));
  readonly #lifecycle = new AsyncMutex();
  #operation: WorkbenchOperation | undefined;
  #updatedAt = new Date().toISOString();

  async probe(baseUrl: string): Promise<unknown> {
    return (await probeGateway(baseUrl)).probe;
  }

  async beginSession(baseUrl: string): Promise<unknown> {
    return this.#lifecycle.runExclusive(async () => {
      this.#transactions.clear();
      this.#operation = undefined;
      return this.#sessions.begin(baseUrl);
    });
  }

  async endSession(): Promise<unknown> {
    return this.#lifecycle.runExclusive(() => {
      const result = this.#sessions.end();
      this.#transactions.clear();
      this.#operation = undefined;
      this.#touch();
      return result;
    });
  }

  async sessionStatus(): Promise<unknown> {
    return this.#lifecycle.runExclusive(() => this.#sessions.status());
  }

  async workbenchStatus(): Promise<WorkbenchSnapshot> {
    return this.#lifecycle.runExclusive(() => this.#workbenchSnapshot());
  }

  #workbenchSnapshot(): WorkbenchSnapshot {
    const currentSession = this.#sessions.status();
    const session = {
      state: currentSession.state,
      ...(currentSession.mode ? { mode: currentSession.mode } : {}),
      ...(currentSession.writeDisabledReasons ? { writeDisabledReasons: currentSession.writeDisabledReasons } : {}),
    };
    return ({
      updatedAt: this.#updatedAt,
      session,
      ...(this.#operation ? { operation: this.#operation } : {}),
    });
  }

  async read(resource: ReadResource, filters: Record<string, unknown>): Promise<unknown> {
    return this.#runOperation("read", `读取 ${resource}`, () => this.#sessions.requireReady().api.read(resource, filters));
  }

  async planChange(operation: string, payload: unknown): Promise<unknown> {
    return this.#runOperation("plan", `生成 ${operation} 变更计划`, () =>
      this.#transactions.plan(this.#sessions.requireWritable(), operation, payload));
  }

  async createBackup(
    fileName: string,
    outputDir: string,
    cloud: boolean,
  ): Promise<unknown> {
    return this.#runOperation("backup", "创建并校验备份", () =>
      this.#transactions.createBackup(this.#sessions.requireReady(), fileName, outputDir, cloud));
  }

  async applyChange(
    planToken: string,
    backupReceipt: string,
    confirmation: string,
  ): Promise<unknown> {
    return this.#runOperation("apply", "执行已确认的变更", () => this.#transactions.apply(
        this.#sessions.requireWritable(),
        planToken,
        backupReceipt,
        confirmation,
      ));
  }

  async rollback(changeId: string, confirmation: string): Promise<unknown> {
    return this.#runOperation("rollback", "回滚并校验变更", () =>
      this.#transactions.rollback(this.#sessions.requireWritable(), changeId, confirmation));
  }

  async #runOperation<T>(stage: WorkbenchOperation["stage"], summary: string, action: () => Promise<T>): Promise<T> {
    return this.#lifecycle.runExclusive(async () => {
      this.#operation = { stage, state: "running", startedAt: new Date().toISOString(), summary };
      this.#touch();
      try {
        const result = await action();
        const safeResult = result && typeof result === "object" && !Array.isArray(result)
          ? safeValue(result) as Record<string, unknown>
          : undefined;
        this.#operation = {
          ...this.#operation!,
          state: "succeeded",
          finishedAt: new Date().toISOString(),
          ...(safeResult ? { result: safeResult } : {}),
        };
        this.#touch();
        return result;
      } catch (error) {
        const normalized = asMijiaFlowError(error);
        this.#operation = {
          ...this.#operation!,
          state: "failed",
          finishedAt: new Date().toISOString(),
          errorCode: normalized.code,
        };
        this.#touch();
        throw error;
      }
    });
  }

  #updateOperation(progress: WorkbenchProgress): void {
    const current = this.#operation;
    const startedAt = current?.stage === progress.stage ? current.startedAt : new Date().toISOString();
    const operation: WorkbenchOperation = { stage: progress.stage, state: progress.state, startedAt };
    if (progress.state !== "running") operation.finishedAt = new Date().toISOString();
    const summary = progress.summary ?? current?.summary;
    if (summary) operation.summary = summary;
    const diff = progress.diff ? safeDiff(progress.diff) : current?.diff;
    if (diff) operation.diff = diff;
    if (progress.result) operation.result = safeValue(progress.result) as Record<string, unknown>;
    if (progress.errorCode) operation.errorCode = progress.errorCode;
    this.#operation = operation;
    this.#touch();
  }

  #touch(): void { this.#updatedAt = new Date().toISOString(); }
}
