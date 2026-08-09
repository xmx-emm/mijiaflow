import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import type { ValidatedTarget } from "../src/security/lan-target.js";
import { AeadChannel } from "../src/protocol/aead-channel.js";
import { compressPayload, decompressPayload } from "../src/protocol/compression.js";
import { Ecjpake } from "../src/protocol/ecjpake.js";
import { decodeFrame, encodeFrame, FrameType } from "../src/protocol/frame-codec.js";

export const NO_RESPONSE = Symbol("NO_RESPONSE");

export type FakeGatewayHandler = (method: string, params: unknown) => unknown | Promise<unknown>;

export class FakeGateway {
  readonly #passcode: string;
  readonly #handler: FakeGatewayHandler;
  readonly #server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });

  constructor(passcode: string, handler: FakeGatewayHandler) {
    this.#passcode = passcode;
    this.#handler = handler;
  }

  async start(): Promise<ValidatedTarget> {
    await once(this.#server, "listening");
    this.#server.on("connection", (socket) => this.#serve(socket));
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Unexpected fake gateway address");
    return {
      url: new URL(`http://127.0.0.1:${address.port}/`),
      addresses: ["127.0.0.1"],
    };
  }

  async stop(): Promise<void> {
    for (const client of this.#server.clients) client.terminate();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #serve(socket: WebSocket): void {
    const pake = new Ecjpake("server", this.#passcode);
    let bootstrap: AeadChannel | undefined;
    let receive: AeadChannel | undefined;
    let send: AeadChannel | undefined;
    socket.on("message", (raw, binary) => {
      if (!binary) {
        socket.close();
        return;
      }
      void (async () => {
        const bytes = new Uint8Array(raw as Buffer);
        const frame = decodeFrame(bytes);
        switch (frame.type) {
          case FrameType.ProtocolList:
            socket.send(encodeFrame(
              FrameType.SelectedProtocol,
              new TextEncoder().encode(JSON.stringify({ protocol: "passcode", params: {} })),
            ));
            break;
          case FrameType.EcjpakeRoundOne:
            pake.readRoundOne(frame.payload);
            socket.send(encodeFrame(FrameType.EcjpakeRoundOne, pake.writeRoundOne()));
            break;
          case FrameType.EcjpakeRoundTwo: {
            const shared = pake.readRoundTwo(frame.payload);
            socket.send(encodeFrame(FrameType.EcjpakeRoundTwo, pake.writeRoundTwo()));
            bootstrap = new AeadChannel(shared.subarray(0, 16), shared.subarray(16, 24));
            shared.fill(0);
            break;
          }
          case FrameType.SessionKeyExchange: {
            if (!bootstrap) throw new Error("Missing fake gateway bootstrap cipher");
            const clientMaterial = bootstrap.decrypt(frame.payload);
            receive = new AeadChannel(clientMaterial.subarray(0, 16), clientMaterial.subarray(16, 24));
            clientMaterial.fill(0);
            const serverMaterial = randomBytes(24);
            send = new AeadChannel(serverMaterial.subarray(0, 16), serverMaterial.subarray(16, 24));
            socket.send(encodeFrame(FrameType.SessionKeyExchange, bootstrap.encrypt(serverMaterial)));
            serverMaterial.fill(0);
            bootstrap.dispose();
            bootstrap = undefined;
            break;
          }
          case FrameType.Data: {
            if (!receive || !send) throw new Error("Fake gateway session is not ready");
            const rpc = JSON.parse(new TextDecoder().decode(decompressPayload(receive.decrypt(frame.payload)))) as {
              jsonrpc: string;
              id: number;
              method: string;
              params: unknown;
            };
            const result = await this.#handler(rpc.method.replace(/^\/api\//, ""), rpc.params);
            if (result === NO_RESPONSE) return;
            const response = compressPayload(new TextEncoder().encode(JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result,
            })));
            socket.send(encodeFrame(FrameType.Data, send.encrypt(response)));
            break;
          }
        }
      })().catch(() => {
        if (socket.readyState === socket.OPEN) socket.send(encodeFrame(FrameType.Error));
        socket.close();
      });
    });
  }
}
