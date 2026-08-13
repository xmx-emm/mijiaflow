import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { MijiaFlowError } from "../errors.js";
import type { SessionContext } from "../session/session-manager.js";
import { decodeBackup, encodeBackup, type BackupDocument } from "./backup-codec.js";
import { diffJson, digestJson } from "./canonical-json.js";
import {
  applyPreparedOperation,
  objectFromBackup,
  prepareOperation,
  readPreparedObject,
  restorePreparedBaseline,
  type PreparedOperation,
} from "./operations.js";
import type { WorkbenchProgress } from "../workbench.js";

const PLAN_TTL_MS = 10 * 60_000;
const RECEIPT_TTL_MS = 30 * 60_000;
const CHANGE_TTL_MS = 60 * 60_000;

interface PlanRecord {
  token: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  confirmation: string;
  consumed: boolean;
  operation: PreparedOperation;
  baselineDigest: string;
  targetDigest: string;
}

interface ReceiptRecord {
  token: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  path: string;
  fileDigest: string;
  backupDigest: string;
}

interface ChangeRecord {
  id: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  confirmation: string;
  consumed: boolean;
  operation: PreparedOperation;
  afterDigest: string;
  source: "applied" | "recovery";
}

function token(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

function confirmation(prefix: "APPLY" | "ROLLBACK"): string {
  return `${prefix} MIJIAFLOW ${randomBytes(4).toString("hex").toUpperCase()}`;
}

function exactMatch(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed || basename(trimmed) !== trimmed || /[<>:"/\\|?*\u0000-\u001f]/.test(trimmed)) {
    throw new MijiaFlowError("fileName must be a plain portable filename", "INVALID_BACKUP_PATH");
  }
  return extname(trimmed) ? trimmed : `${trimmed}.bak`;
}

function cloudFileName(fileName: string): string {
  const extension = extname(fileName);
  return extension
    ? `${fileName.slice(0, -extension.length)}.cloud${extension}`
    : `${fileName}.cloud`;
}

function backupContentDigests(document: BackupDocument): { automations: string; variables: string } {
  return {
    automations: digestJson([...document.rules].sort((left, right) => left.id.localeCompare(right.id))),
    variables: digestJson(document.variables),
  };
}

async function writeVerifiedBackup(document: BackupDocument, outputDir: string, fileName: string): Promise<{
  path: string;
  fileDigest: string;
  backupDigest: string;
  bytes: number;
}> {
  if (!isAbsolute(outputDir)) {
    throw new MijiaFlowError("outputDir must be an absolute path", "INVALID_BACKUP_PATH");
  }
  await mkdir(outputDir, { recursive: true });
  const directory = await realpath(outputDir);
  const path = resolve(directory, safeFileName(fileName));
  if (!path.startsWith(`${directory}\\`) && !path.startsWith(`${directory}/`)) {
    throw new MijiaFlowError("Backup path escapes outputDir", "INVALID_BACKUP_PATH");
  }
  const encoded = encodeBackup(document);
  await writeFile(path, encoded, { flag: "wx", mode: 0o600 });
  const reopened = await readFile(path);
  const decoded = decodeBackup(reopened);
  return {
    path,
    fileDigest: createHash("sha256").update(reopened).digest("hex"),
    backupDigest: decoded.digest,
    bytes: reopened.length,
  };
}

export class TransactionManager {
  readonly #plans = new Map<string, PlanRecord>();
  readonly #receipts = new Map<string, ReceiptRecord>();
  readonly #changes = new Map<string, ChangeRecord>();
  readonly #rollbackDirectory: string;
  #applying = false;
  readonly #onProgress: ((progress: WorkbenchProgress) => void) | undefined;

  constructor(
    onProgressOrDirectory?: ((progress: WorkbenchProgress) => void) | string,
    rollbackDirectory = join(homedir(), ".mijiaflow", "backups"),
  ) {
    this.#onProgress = typeof onProgressOrDirectory === "function" ? onProgressOrDirectory : undefined;
    this.#rollbackDirectory = typeof onProgressOrDirectory === "string" ? onProgressOrDirectory : rollbackDirectory;
  }

  clear(): void {
    this.#plans.clear();
    this.#receipts.clear();
    this.#changes.clear();
  }

  async plan(context: SessionContext, operation: string, payload: unknown): Promise<Record<string, unknown>> {
    this.#onProgress?.({ stage: "plan", state: "running", summary: `生成 ${operation} 变更计划` });
    if (context.probe.mode !== "read-write") {
      throw new MijiaFlowError("This gateway version is read-only", "READ_ONLY_VERSION");
    }
    this.#prune();
    const prepared = await prepareOperation(context.api, operation, payload);
    const baselineDigest = digestJson(prepared.baseline);
    const targetDigest = digestJson(prepared.target);
    if (baselineDigest === targetDigest) {
      throw new MijiaFlowError("Planned operation would not change the object", "NO_CHANGE");
    }
    const createdAt = Date.now();
    const record: PlanRecord = {
      token: token(),
      sessionId: context.id,
      createdAt,
      expiresAt: createdAt + PLAN_TTL_MS,
      confirmation: confirmation("APPLY"),
      consumed: false,
      operation: prepared,
      baselineDigest,
      targetDigest,
    };
    this.#plans.set(record.token, record);
    const result = {
      planToken: record.token,
      operation: prepared.name,
      objectKey: prepared.objectKey,
      summary: prepared.summary,
      diff: diffJson(prepared.baseline, prepared.target),
      baselineDigest,
      targetDigest,
      confirmation: record.confirmation,
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
    this.#onProgress?.({ stage: "plan", state: "succeeded", summary: prepared.summary, diff: result.diff });
    return result;
  }

  async createBackup(
    context: SessionContext,
    fileName: string,
    outputDir: string,
    cloud: boolean,
  ): Promise<Record<string, unknown>> {
    this.#onProgress?.({ stage: "backup", state: "running", summary: "读取并写入备份文件" });
    this.#prune();
    if (cloud && context.probe.mode !== "read-write") {
      throw new MijiaFlowError("Cloud backup is disabled for an unknown gateway version", "READ_ONLY_VERSION");
    }
    const before = cloud ? await context.api.snapshot() : undefined;
    const document: BackupDocument = before
      ? { version: 2, rules: before.automations, variables: before.variables }
      : await context.api.backupDocument();
    const local = await writeVerifiedBackup(document, outputDir, fileName);
    const createdAt = Date.now();
    const receipt: ReceiptRecord = {
      token: token(),
      sessionId: context.id,
      createdAt,
      expiresAt: createdAt + RECEIPT_TTL_MS,
      path: local.path,
      fileDigest: local.fileDigest,
      backupDigest: local.backupDigest,
    };
    this.#receipts.set(receipt.token, receipt);
    let cloudResult: Record<string, unknown> | undefined;
    if (cloud) {
      const result = await context.api.createCloudBackup(safeFileName(fileName));
      const after = await context.api.snapshot();
      const invariantDigests = {
        automationsBefore: digestJson(before!.automations),
        automationsAfter: digestJson(after.automations),
        variablesBefore: digestJson(before!.variables),
        variablesAfter: digestJson(after.variables),
        settingsBefore: digestJson(before!.backupConfig),
        settingsAfter: digestJson(after.backupConfig),
      };
      if (
        invariantDigests.automationsBefore !== invariantDigests.automationsAfter ||
        invariantDigests.variablesBefore !== invariantDigests.variablesAfter ||
        invariantDigests.settingsBefore !== invariantDigests.settingsAfter
      ) {
        throw new MijiaFlowError("Business configuration changed during cloud backup", "BACKUP_INVARIANT_FAILED", invariantDigests);
      }
      const expectedContentDigests = backupContentDigests(document);
      const downloadedContentDigests = backupContentDigests(result.document);
      if (
        expectedContentDigests.automations !== downloadedContentDigests.automations ||
        expectedContentDigests.variables !== downloadedContentDigests.variables
      ) {
        throw new MijiaFlowError(
          "Downloaded cloud backup does not match the pre-backup automation and variable snapshot",
          "CLOUD_BACKUP_CONTENT_MISMATCH",
          { expectedContentDigests, downloadedContentDigests, recordBinding: result.binding },
        );
      }
      const downloaded = await writeVerifiedBackup(
        result.document,
        outputDir,
        cloudFileName(safeFileName(fileName)),
      );
      cloudResult = {
        status: "created-downloaded-verified",
        record: result.record,
        recordBinding: result.binding,
        path: downloaded.path,
        fileDigest: downloaded.fileDigest,
        backupDigest: downloaded.backupDigest,
        contentDigests: downloadedContentDigests,
        invariantDigests,
      };
    }
    const result = {
      backupReceipt: receipt.token,
      path: local.path,
      bytes: local.bytes,
      fileDigest: local.fileDigest,
      backupDigest: local.backupDigest,
      coverage: { automations: document.rules.length, variableScopes: Object.keys(document.variables).length },
      expiresAt: new Date(receipt.expiresAt).toISOString(),
      cloud: cloudResult ?? { status: "not-requested" },
    };
    this.#onProgress?.({ stage: "backup", state: "succeeded", summary: "备份已校验", result });
    return result;
  }

  async apply(
    context: SessionContext,
    planToken: string,
    backupReceipt: string,
    suppliedConfirmation: string,
  ): Promise<Record<string, unknown>> {
    this.#onProgress?.({ stage: "apply", state: "running", summary: "检查计划、备份和当前基线" });
    if (this.#applying) {
      throw new MijiaFlowError("Another MijiaFlow write is in progress", "WRITE_IN_PROGRESS");
    }
    this.#applying = true;
    try {
      this.#prune();
      const plan = this.#plans.get(planToken);
      const receipt = this.#receipts.get(backupReceipt);
      if (!plan || plan.consumed || plan.sessionId !== context.id) {
        throw new MijiaFlowError("Plan token is invalid, expired, or already used", "INVALID_PLAN");
      }
      if (!receipt || receipt.sessionId !== context.id) {
        throw new MijiaFlowError("Backup receipt is invalid or expired", "INVALID_BACKUP_RECEIPT");
      }
      if (!exactMatch(suppliedConfirmation, plan.confirmation)) {
        throw new MijiaFlowError("Confirmation phrase does not match the plan", "CONFIRMATION_MISMATCH");
      }
      if (receipt.createdAt < plan.createdAt) {
        throw new MijiaFlowError("Backup must be created after the plan baseline", "STALE_BACKUP_RECEIPT");
      }
      const reopened = await readFile(receipt.path);
      const fileDigest = createHash("sha256").update(reopened).digest("hex");
      if (fileDigest !== receipt.fileDigest) {
        throw new MijiaFlowError("Backup file changed after verification", "INVALID_BACKUP_RECEIPT");
      }
      const decoded = decodeBackup(reopened);
      if (decoded.digest !== receipt.backupDigest) {
        throw new MijiaFlowError("Backup digest no longer matches its receipt", "INVALID_BACKUP_RECEIPT");
      }
      const coveredObject = objectFromBackup(decoded.document, plan.operation);
      if (digestJson(coveredObject) !== plan.baselineDigest) {
        throw new MijiaFlowError("Backup does not cover the planned baseline", "BACKUP_COVERAGE_MISMATCH");
      }
      const current = await readPreparedObject(context.api, plan.operation);
      if (digestJson(current) !== plan.baselineDigest) {
        throw new MijiaFlowError("Object changed after planning; create a new plan", "CONCURRENT_CHANGE");
      }
      plan.consumed = true;
      try {
        await applyPreparedOperation(context.api, plan.operation);
        this.#onProgress?.({ stage: "verify", state: "running", summary: "读取回执并验证网关状态" });
        const verified = await readPreparedObject(context.api, plan.operation);
        if (digestJson(verified) !== plan.targetDigest) {
          throw new MijiaFlowError("Gateway readback did not match the planned target", "WRITE_VERIFICATION_FAILED");
        }
      } catch (error) {
        let restored = false;
        let observedAfterCompensation: unknown;
        let hasObservedAfterCompensation = false;
        try {
          await restorePreparedBaseline(context.api, plan.operation);
          observedAfterCompensation = await readPreparedObject(context.api, plan.operation);
          hasObservedAfterCompensation = true;
          restored = digestJson(observedAfterCompensation) === plan.baselineDigest;
        } catch {
          restored = false;
        }
        if (!restored && !hasObservedAfterCompensation) {
          try {
            observedAfterCompensation = await readPreparedObject(context.api, plan.operation);
            hasObservedAfterCompensation = true;
            restored = digestJson(observedAfterCompensation) === plan.baselineDigest;
          } catch {
            hasObservedAfterCompensation = false;
          }
        }
        const recovery = !restored && hasObservedAfterCompensation
          ? this.#recordChange(context, plan.operation, digestJson(observedAfterCompensation), "recovery")
          : undefined;
        throw new MijiaFlowError(
          error instanceof Error ? error.message : "Gateway write failed",
          "WRITE_FAILED",
          {
            restored,
            recoveryAvailable: recovery !== undefined,
            ...(recovery ? { recovery } : {}),
          },
        );
      }
      const change = this.#recordChange(context, plan.operation, plan.targetDigest, "applied");
      const result = {
        changeId: change.changeId,
        status: "applied-and-verified",
        beforeDigest: plan.baselineDigest,
        afterDigest: plan.targetDigest,
        rollbackConfirmation: change.rollbackConfirmation,
        rollbackExpiresAt: change.rollbackExpiresAt,
      };
      this.#onProgress?.({ stage: "verify", state: "succeeded", summary: "变更已应用并验证", result });
      this.#onProgress?.({ stage: "apply", state: "succeeded", summary: "变更已应用并验证", result });
      return result;
    } finally {
      this.#applying = false;
    }
  }

  async rollback(
    context: SessionContext,
    changeId: string,
    suppliedConfirmation: string,
  ): Promise<Record<string, unknown>> {
    this.#onProgress?.({ stage: "rollback", state: "running", summary: "检查变更并创建回滚前备份" });
    if (this.#applying) {
      throw new MijiaFlowError("Another MijiaFlow write is in progress", "WRITE_IN_PROGRESS");
    }
    this.#applying = true;
    try {
      this.#prune();
      const change = this.#changes.get(changeId);
      if (!change || change.consumed || change.sessionId !== context.id) {
        throw new MijiaFlowError("Change identifier is invalid, expired, or already rolled back", "INVALID_CHANGE");
      }
      if (!exactMatch(suppliedConfirmation, change.confirmation)) {
        throw new MijiaFlowError("Rollback confirmation phrase does not match", "CONFIRMATION_MISMATCH");
      }
      const current = await readPreparedObject(context.api, change.operation);
      if (digestJson(current) !== change.afterDigest) {
        throw new MijiaFlowError("Object changed after apply; rollback will not overwrite it", "CONCURRENT_CHANGE");
      }
      const preRollback = await context.api.backupDocument();
      const rollbackBackup = await writeVerifiedBackup(
        preRollback,
        this.#rollbackDirectory,
        `pre-rollback-${Date.now()}-${token(4)}.bak`,
      );
      const afterBackup = await readPreparedObject(context.api, change.operation);
      if (digestJson(afterBackup) !== change.afterDigest) {
        throw new MijiaFlowError(
          "Object changed while the rollback backup was being created; rollback will not overwrite it",
          "CONCURRENT_CHANGE",
        );
      }
      await restorePreparedBaseline(context.api, change.operation);
      const restored = await readPreparedObject(context.api, change.operation);
      const restoredDigest = digestJson(restored);
      const baselineDigest = digestJson(change.operation.baseline);
      if (restoredDigest !== baselineDigest) {
        throw new MijiaFlowError("Rollback readback did not match the retained baseline", "ROLLBACK_VERIFICATION_FAILED");
      }
      change.consumed = true;
      const result = {
        changeId,
        status: "rolled-back-and-verified",
        restoredDigest,
        preRollbackBackup: rollbackBackup.path,
      };
      this.#onProgress?.({ stage: "rollback", state: "succeeded", summary: "已回滚并验证", result });
      return result;
    } finally {
      this.#applying = false;
    }
  }

  #recordChange(
    context: SessionContext,
    operation: PreparedOperation,
    afterDigest: string,
    source: ChangeRecord["source"],
  ): { changeId: string; rollbackConfirmation: string; rollbackExpiresAt: string; guardDigest: string } {
    const changeId = token();
    const rollbackConfirmation = confirmation("ROLLBACK");
    const now = Date.now();
    const expiresAt = now + CHANGE_TTL_MS;
    this.#changes.set(changeId, {
      id: changeId,
      sessionId: context.id,
      createdAt: now,
      expiresAt,
      confirmation: rollbackConfirmation,
      consumed: false,
      operation,
      afterDigest,
      source,
    });
    return {
      changeId,
      rollbackConfirmation,
      rollbackExpiresAt: new Date(expiresAt).toISOString(),
      guardDigest: afterDigest,
    };
  }

  #prune(): void {
    const now = Date.now();
    for (const [key, value] of this.#plans) if (value.expiresAt <= now) this.#plans.delete(key);
    for (const [key, value] of this.#receipts) if (value.expiresAt <= now) this.#receipts.delete(key);
    for (const [key, value] of this.#changes) if (value.expiresAt <= now) this.#changes.delete(key);
  }
}
