import { probeGateway } from "./domain/compatibility.js";
import type { ReadResource } from "./domain/gateway-api.js";
import { TransactionManager } from "./domain/transaction-manager.js";
import { SessionManager } from "./session/session-manager.js";
import { AsyncMutex } from "./util/async-mutex.js";

export class MijiaFlowService {
  readonly #sessions = new SessionManager();
  readonly #transactions = new TransactionManager();
  readonly #lifecycle = new AsyncMutex();

  async probe(baseUrl: string): Promise<unknown> {
    return (await probeGateway(baseUrl)).probe;
  }

  async beginSession(baseUrl: string): Promise<unknown> {
    return this.#lifecycle.runExclusive(async () => {
      this.#transactions.clear();
      return this.#sessions.begin(baseUrl);
    });
  }

  async endSession(): Promise<unknown> {
    return this.#lifecycle.runExclusive(() => {
      const result = this.#sessions.end();
      this.#transactions.clear();
      return result;
    });
  }

  async read(resource: ReadResource, filters: Record<string, unknown>): Promise<unknown> {
    return this.#lifecycle.runExclusive(() => this.#sessions.requireReady().api.read(resource, filters));
  }

  async planChange(operation: string, payload: unknown): Promise<unknown> {
    return this.#lifecycle.runExclusive(() =>
      this.#transactions.plan(this.#sessions.requireWritable(), operation, payload));
  }

  async createBackup(
    fileName: string,
    outputDir: string,
    cloud: boolean,
  ): Promise<unknown> {
    return this.#lifecycle.runExclusive(() =>
      this.#transactions.createBackup(this.#sessions.requireReady(), fileName, outputDir, cloud));
  }

  async applyChange(
    planToken: string,
    backupReceipt: string,
    confirmation: string,
  ): Promise<unknown> {
    return this.#lifecycle.runExclusive(() =>
      this.#transactions.apply(
        this.#sessions.requireWritable(),
        planToken,
        backupReceipt,
        confirmation,
      ));
  }

  async rollback(changeId: string, confirmation: string): Promise<unknown> {
    return this.#lifecycle.runExclusive(() =>
      this.#transactions.rollback(this.#sessions.requireWritable(), changeId, confirmation));
  }
}
