import { randomBytes } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { MijiaFlowError } from "../errors.js";
import { createPinnedLookup, revalidateTarget, type ValidatedTarget } from "../security/lan-target.js";
import { AeadChannel } from "./aead-channel.js";
import { compressPayload, decompressPayload } from "./compression.js";
import { Ecjpake } from "./ecjpake.js";
import { decodeFrame, encodeFrame, FrameType, MAX_FRAME_BYTES } from "./frame-codec.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function websocketUrl(target: ValidatedTarget): string {
  const url = new URL("centrallinkws/", target.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export interface GatewayRpc {
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

export type GatewayClientState =
  | "idle"
  | "connecting"
  | "awaiting-passcode"
  | "authenticating"
  | "ready"
  | "closed";

type HandshakePhase =
  | "idle"
  | "protocol-list-sent"
  | "protocol-selected"
  | "client-round-one-sent"
  | "server-round-one-received"
  | "client-round-two-sent"
  | "server-round-two-received"
  | "client-session-key-sent"
  | "ready";

export class GatewayClient implements GatewayRpc {
  readonly #target: ValidatedTarget;
  readonly #selected = deferred<void>();
  readonly #ready = deferred<void>();
  readonly #pending = new Map<number, PendingRequest>();
  #socket: WebSocket | undefined;
  #pake: Ecjpake | undefined;
  #bootstrapCipher: AeadChannel | undefined;
  #sendCipher: AeadChannel | undefined;
  #receiveCipher: AeadChannel | undefined;
  #nextRequestId = 0;
  #state: GatewayClientState = "idle";
  #handshakePhase: HandshakePhase = "idle";

  constructor(target: ValidatedTarget) {
    this.#target = target;
    void this.#selected.promise.catch(() => undefined);
    void this.#ready.promise.catch(() => undefined);
  }

  get state(): GatewayClientState {
    return this.#state;
  }

  async start(timeoutMs = 8_000): Promise<void> {
    if (this.#state !== "idle") {
      throw new MijiaFlowError("Gateway client has already been started", "INVALID_SESSION_STATE");
    }
    try {
      await revalidateTarget(this.#target);
      this.#state = "connecting";
      this.#socket = new WebSocket(websocketUrl(this.#target), {
        followRedirects: false,
        handshakeTimeout: timeoutMs,
        lookup: createPinnedLookup(this.#target),
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
      });
      this.#socket.on("open", () => {
        try {
          this.#handshakePhase = "protocol-list-sent";
          this.#diagnose("handshake_progress");
          this.#send(FrameType.ProtocolList, new TextEncoder().encode(JSON.stringify(["passcode"])));
        } catch (error) {
          this.#abort(this.#coerceError(error));
        }
      });
      this.#socket.on("message", (data, isBinary) => {
        if (!isBinary) {
          this.#abort(new MijiaFlowError("Gateway sent a text WebSocket frame", "INVALID_FRAME"));
          return;
        }
        void this.#handleMessage(data).catch((error: unknown) => this.#abort(this.#coerceError(error)));
      });
      this.#socket.on("error", () => {
        this.#abort(new MijiaFlowError("Gateway WebSocket failed", "CONNECTION_FAILED"));
      });
      this.#socket.on("close", () => {
        if (this.#state !== "closed") {
          this.#abort(new MijiaFlowError("Gateway WebSocket closed", "SESSION_CLOSED"));
        }
      });
      await this.#withTimeout(this.#selected.promise, timeoutMs, "Gateway did not select passcode pairing");
    } catch (error) {
      const normalized = this.#coerceError(error);
      this.#diagnose("connection_failed", normalized);
      this.#abort(normalized);
      throw normalized;
    }
  }

  async authenticate(passcode: string, timeoutMs = 15_000): Promise<void> {
    if (this.#state !== "awaiting-passcode") {
      throw new MijiaFlowError("Gateway is not waiting for a passcode", "INVALID_SESSION_STATE");
    }
    try {
      this.#state = "authenticating";
      this.#pake = new Ecjpake("client", passcode);
      this.#send(FrameType.EcjpakeRoundOne, this.#pake.writeRoundOne());
      this.#handshakePhase = "client-round-one-sent";
      this.#diagnose("handshake_progress");
      await this.#withTimeout(this.#ready.promise, timeoutMs, "Gateway authentication timed out");
    } catch (error) {
      const normalized = this.#coerceError(error);
      this.#diagnose("authentication_failed", normalized);
      this.#abort(normalized);
      throw normalized;
    }
  }

  async call(method: string, params: unknown, timeoutMs = 5_000): Promise<unknown> {
    if (this.#state !== "ready" || !this.#sendCipher) {
      throw new MijiaFlowError("Secure gateway session is not established", "SESSION_NOT_READY");
    }
    const id = this.#allocateRequestId();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new MijiaFlowError(`Gateway method ${method} timed out`, "RPC_TIMEOUT"));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    const rpc = { jsonrpc: "2.0", id, method: `/api/${method}`, params };
    try {
      const compressed = compressPayload(new TextEncoder().encode(JSON.stringify(rpc)));
      this.#send(FrameType.Data, this.#sendCipher.encrypt(compressed));
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
      }
      throw error;
    }
    return response;
  }

  close(): void {
    this.#abort(new MijiaFlowError("Gateway session ended", "SESSION_CLOSED"));
  }

  async #handleMessage(raw: RawData): Promise<void> {
    const data = raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : Array.isArray(raw)
        ? Uint8Array.from(Buffer.concat(raw))
        : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const frame = decodeFrame(data);
    this.#diagnose("handshake_frame_received", undefined, frame.type);
    switch (frame.type) {
      case FrameType.SelectedProtocol: {
        if (this.#state !== "connecting") {
          throw new MijiaFlowError("Selected-protocol frame arrived out of order", "INVALID_HANDSHAKE");
        }
        const selected = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload)) as unknown;
        if (
          !selected ||
          typeof selected !== "object" ||
          (selected as Record<string, unknown>).protocol !== "passcode"
        ) {
          throw new MijiaFlowError("Gateway did not select the passcode protocol", "UNSUPPORTED_PROTOCOL");
        }
        this.#state = "awaiting-passcode";
        this.#handshakePhase = "protocol-selected";
        this.#diagnose("handshake_progress");
        this.#selected.resolve();
        break;
      }
      case FrameType.EcjpakeRoundOne: {
        if (this.#state !== "authenticating" || !this.#pake) {
          throw new MijiaFlowError("ECJPAKE round one arrived out of order", "INVALID_HANDSHAKE");
        }
        this.#handshakePhase = "server-round-one-received";
        this.#diagnose("handshake_progress");
        this.#pake.readRoundOne(frame.payload);
        this.#send(FrameType.EcjpakeRoundTwo, this.#pake.writeRoundTwo());
        this.#handshakePhase = "client-round-two-sent";
        this.#diagnose("handshake_progress");
        break;
      }
      case FrameType.EcjpakeRoundTwo: {
        if (this.#state !== "authenticating" || !this.#pake) {
          throw new MijiaFlowError("ECJPAKE round two arrived out of order", "INVALID_HANDSHAKE");
        }
        this.#handshakePhase = "server-round-two-received";
        this.#diagnose("handshake_progress");
        const shared = this.#pake.readRoundTwo(frame.payload);
        this.#bootstrapCipher = new AeadChannel(shared.subarray(0, 16), shared.subarray(16, 24));
        shared.fill(0);
        const outbound = randomBytes(24);
        this.#sendCipher = new AeadChannel(outbound.subarray(0, 16), outbound.subarray(16, 24));
        this.#send(FrameType.SessionKeyExchange, this.#bootstrapCipher.encrypt(outbound));
        this.#handshakePhase = "client-session-key-sent";
        this.#diagnose("handshake_progress");
        outbound.fill(0);
        this.#pake = undefined;
        break;
      }
      case FrameType.SessionKeyExchange: {
        if (this.#state !== "authenticating" || !this.#bootstrapCipher) {
          throw new MijiaFlowError("Session-key frame arrived out of order", "INVALID_HANDSHAKE");
        }
        const inbound = this.#bootstrapCipher.decrypt(frame.payload);
        if (inbound.length !== 24) {
          inbound.fill(0);
          throw new MijiaFlowError("Gateway session material has the wrong length", "INVALID_HANDSHAKE");
        }
        this.#receiveCipher = new AeadChannel(inbound.subarray(0, 16), inbound.subarray(16, 24));
        inbound.fill(0);
        this.#bootstrapCipher.dispose();
        this.#bootstrapCipher = undefined;
        this.#state = "ready";
        this.#handshakePhase = "ready";
        this.#diagnose("handshake_progress");
        this.#ready.resolve();
        break;
      }
      case FrameType.Data:
        this.#handleData(frame.payload);
        break;
      case FrameType.Error:
        throw new MijiaFlowError("Gateway rejected authentication or protocol state", "GATEWAY_REJECTED");
      default:
        throw new MijiaFlowError(`Unexpected gateway frame type ${frame.type}`, "INVALID_HANDSHAKE");
    }
  }

  #handleData(payload: Uint8Array): void {
    if (this.#state !== "ready" || !this.#receiveCipher) {
      throw new MijiaFlowError("Application data arrived before the secure session", "INVALID_HANDSHAKE");
    }
    const plaintext = decompressPayload(this.#receiveCipher.decrypt(payload));
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    } catch {
      throw new MijiaFlowError("Gateway JSON-RPC response is invalid", "INVALID_RPC_RESPONSE");
    }
    if (!message || typeof message !== "object") {
      throw new MijiaFlowError("Gateway JSON-RPC response is not an object", "INVALID_RPC_RESPONSE");
    }
    const rpc = message as Record<string, unknown>;
    if (rpc.jsonrpc !== "2.0" || !Number.isInteger(rpc.id)) {
      throw new MijiaFlowError("Gateway JSON-RPC response has an invalid envelope", "INVALID_RPC_RESPONSE");
    }
    const id = rpc.id as number;
    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if (Object.hasOwn(rpc, "result") === Object.hasOwn(rpc, "error")) {
      pending.reject(new MijiaFlowError("Gateway response must contain result or error", "INVALID_RPC_RESPONSE"));
      return;
    }
    if (Object.hasOwn(rpc, "error")) {
      const error = rpc.error as Record<string, unknown> | undefined;
      pending.reject(
        new MijiaFlowError(
          typeof error?.message === "string" ? error.message : "Gateway RPC failed",
          "GATEWAY_RPC_ERROR",
          typeof error?.code === "number" ? { rpcCode: error.code } : undefined,
        ),
      );
      return;
    }
    pending.resolve(rpc.result);
  }

  #send(type: FrameType, payload?: Uint8Array): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new MijiaFlowError("Gateway WebSocket is not open", "SESSION_CLOSED");
    }
    this.#socket.send(encodeFrame(type, payload));
  }

  #allocateRequestId(): number {
    for (let attempts = 0; attempts < 0xffff_ffff; attempts += 1) {
      const id = this.#nextRequestId;
      this.#nextRequestId = (this.#nextRequestId + 1) % 0xffff_ffff;
      if (!this.#pending.has(id)) {
        return id;
      }
    }
    throw new MijiaFlowError("No JSON-RPC request identifiers are available", "RPC_ID_EXHAUSTED");
  }

  #abort(error: Error): void {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    this.#selected.reject(error);
    this.#ready.reject(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#bootstrapCipher?.dispose();
    this.#sendCipher?.dispose();
    this.#receiveCipher?.dispose();
    this.#bootstrapCipher = undefined;
    this.#sendCipher = undefined;
    this.#receiveCipher = undefined;
    this.#pake = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close();
      } catch {
        try {
          socket.terminate();
        } catch {
          // State and key material are already closed even if transport teardown fails.
        }
      }
    }
  }

  async #withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new MijiaFlowError(
            message,
            "HANDSHAKE_TIMEOUT",
            { phase: this.#handshakePhase },
          )), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  #coerceError(error: unknown): Error {
    return error instanceof Error ? error : new MijiaFlowError("Gateway protocol failed", "PROTOCOL_ERROR");
  }

  #diagnose(event: string, error?: Error, frameType?: number): void {
    if (process.env.MIJIAFLOW_DIAGNOSTICS !== "1") return;
    const code = error instanceof MijiaFlowError ? error.code : undefined;
    process.stderr.write(`${JSON.stringify({
      source: "mijiaflow",
      at: new Date().toISOString(),
      event,
      state: this.#state,
      phase: this.#handshakePhase,
      ...(code ? { code } : {}),
      ...(frameType === undefined ? {} : { frameType }),
    })}\n`);
  }
}
