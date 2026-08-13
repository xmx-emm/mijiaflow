import type { JsonDiffEntry } from "./domain/canonical-json.js";
import type { SessionStatus } from "./session/session-manager.js";

export type WorkbenchStage = "session" | "read" | "plan" | "backup" | "apply" | "verify" | "rollback";
export type WorkbenchOperationState = "running" | "succeeded" | "failed";

export interface WorkbenchDiffEntry {
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface WorkbenchOperation {
  stage: WorkbenchStage;
  state: WorkbenchOperationState;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  diff?: WorkbenchDiffEntry[];
  result?: Record<string, unknown>;
  errorCode?: string;
}

/**
 * The latest unapplied plan, displayed with full values on the loopback
 * workbench so the user reviews the authoritative diff before confirming.
 * Opaque tokens and receipts are deliberately excluded.
 */
export interface WorkbenchPendingPlan {
  operation: string;
  objectKey: string;
  summary: string;
  confirmation: string;
  diff: JsonDiffEntry[];
  baselineDigest: string;
  expiresAt: string;
  createdAt: string;
}

export interface WorkbenchSnapshot {
  updatedAt: string;
  session: SessionStatus;
  operation?: WorkbenchOperation;
  pendingPlan?: WorkbenchPendingPlan;
}

export interface WorkbenchProgress {
  stage: WorkbenchStage;
  state: WorkbenchOperationState;
  summary?: string;
  diff?: JsonDiffEntry[];
  result?: Record<string, unknown>;
  errorCode?: string;
}
