import { randomBytes } from "node:crypto";
import { MijiaFlowError } from "../errors.js";
import { probeGateway, type ProbeResult } from "../domain/compatibility.js";
import { GatewayApi } from "../domain/gateway-api.js";
import { GatewayClient } from "../protocol/gateway-client.js";
import { PairingServer, type PairingInfo } from "./pairing-server.js";

interface ActiveSession {
  id: string;
  probe: ProbeResult;
  client: GatewayClient;
  api: GatewayApi;
  pairing: PairingServer;
  pairingExpiresAt: string;
}

export interface BeginSessionResult extends PairingInfo {
  sessionId: string;
  baseUrl: string;
  mode: ProbeResult["mode"];
  state: "awaiting-passcode";
}

export interface SessionContext {
  id: string;
  probe: ProbeResult;
  api: GatewayApi;
}

export type SessionState = "none" | "awaiting-passcode" | "authenticating" | "ready" | "failed";

export interface SessionStatus {
  state: SessionState;
  sessionId?: string;
  baseUrl?: string;
  mode?: ProbeResult["mode"];
  writeDisabledReasons?: string[];
  pairingExpiresAt?: string;
}

export class SessionManager {
  #active: ActiveSession | undefined;
  #lastFailure: SessionStatus | undefined;
  readonly #getWorkbenchState: () => unknown;

  constructor(getWorkbenchState: () => unknown = () => this.status()) {
    this.#getWorkbenchState = getWorkbenchState;
  }

  async begin(baseUrl: string): Promise<BeginSessionResult> {
    this.end();
    this.#lastFailure = undefined;
    const { probe, target } = await probeGateway(baseUrl);
    const client = new GatewayClient(target);
    let pairing: PairingServer | undefined;
    try {
      pairing = new PairingServer(
        async (passcode) => {
          // The gateway allows only 60 seconds between protocol selection and
          // the first PAKE round, so open the WebSocket only after submission.
          await client.start();
          await client.authenticate(passcode);
        },
        () => this.#discard(client),
        { getState: () => this.#getWorkbenchState() },
      );
      const pairingInfo = await pairing.start();
      const active: ActiveSession = {
        id: randomBytes(24).toString("base64url"),
        probe,
        client,
        api: new GatewayApi(client),
        pairing,
        pairingExpiresAt: pairingInfo.expiresAt,
      };
      this.#active = active;
      return {
        ...pairingInfo,
        sessionId: active.id,
        baseUrl: probe.baseUrl,
        mode: probe.mode,
        state: "awaiting-passcode",
      };
    } catch (error) {
      pairing?.close();
      client.close();
      throw error;
    }
  }

  status(): SessionStatus {
    const active = this.#active;
    if (!active) {
      return this.#lastFailure ?? { state: "none" };
    }
    // The WebSocket opens only after the passcode form is submitted, so an
    // idle client means the one-time pairing page is still waiting for input.
    const clientState = active.client.state;
    const state: SessionState =
      clientState === "ready"
        ? "ready"
        : clientState === "closed"
          ? "failed"
          : clientState === "idle"
            ? "awaiting-passcode"
            : "authenticating";
    return {
      state,
      sessionId: active.id,
      baseUrl: active.probe.baseUrl,
      mode: active.probe.mode,
      writeDisabledReasons: active.probe.writeDisabledReasons,
      ...(state === "awaiting-passcode" ? { pairingExpiresAt: active.pairingExpiresAt } : {}),
    };
  }

  requireReady(): SessionContext {
    const active = this.#active;
    if (!active || active.client.state !== "ready") {
      throw new MijiaFlowError("No authenticated Mijia session is ready", "SESSION_NOT_READY");
    }
    return { id: active.id, probe: active.probe, api: active.api };
  }

  requireWritable(): SessionContext {
    const context = this.requireReady();
    if (context.probe.mode !== "read-write") {
      throw new MijiaFlowError("This gateway version is read-only", "READ_ONLY_VERSION", {
        reasons: context.probe.writeDisabledReasons,
      });
    }
    return context;
  }

  end(): { ended: boolean } {
    if (!this.#active) {
      this.#lastFailure = undefined;
      return { ended: false };
    }
    this.#active.pairing.close();
    this.#active.client.close();
    this.#active = undefined;
    this.#lastFailure = undefined;
    return { ended: true };
  }

  #discard(client: GatewayClient): void {
    if (this.#active?.client !== client) {
      client.close();
      return;
    }
    this.#active.client.close();
    // Retain the loopback workbench until an explicit end so the user can see
    // that this session failed instead of landing on a vanished result page.
  }
}
