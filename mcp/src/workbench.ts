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

export interface WorkbenchSnapshot {
  updatedAt: string;
  session: SessionStatus;
  operation?: WorkbenchOperation;
}

export interface WorkbenchProgress {
  stage: WorkbenchStage;
  state: WorkbenchOperationState;
  summary?: string;
  diff?: JsonDiffEntry[];
  result?: Record<string, unknown>;
  errorCode?: string;
}
