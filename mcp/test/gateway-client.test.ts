import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayClient } from "../src/protocol/gateway-client.js";
import { Ecjpake } from "../src/protocol/ecjpake.js";
import { decodeFrame, encodeFrame, FrameType } from "../src/protocol/frame-codec.js";
import { createPinnedLookup, type ValidatedTarget } from "../src/security/lan-target.js";
import { FakeGateway, NO_RESPONSE } from "./fake-gateway.js";

const running: FakeGateway[] = [];
const rawServers: WebSocketServer[] = [];

afterEach(async () => {
  const serverStops = rawServers.splice(0).map((server) => {
    for (const client of server.clients) client.terminate();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await Promise.all([
    ...running.splice(0).map((gateway) => gateway.stop()),
    ...serverStops,
  ]);
});

describe("local fake gateway integration", () => {
  it("completes the independent server handshake and JSON-RPC read", async () => {
    const gateway = new FakeGateway("135790", (method, params) => ({ method, params, ok: true }));
    running.push(gateway);
    const client = new GatewayClient(await gateway.start());
    await client.start();
    await client.authenticate("135790");
    await expect(client.call("getGraphList", { enabled: true })).resolves.toEqual({
      method: "getGraphList",
      params: { enabled: true },
      ok: true,
    });
    client.close();
  });

  it("rejects an incorrect gateway passcode", async () => {
    const gateway = new FakeGateway("correct", () => ({}));
    running.push(gateway);
    const client = new GatewayClient(await gateway.start());
    await client.start();
    await expect(client.authenticate("incorrect", 2_000)).rejects.toThrow();
    expect(client.state).toBe("closed");
  });

  it("closes authentication atomically before delayed handshake frames arrive", async () => {
    const passcode = "late-frame";
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
    rawServers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unexpected test gateway address");
    const target: ValidatedTarget = {
      url: new URL(`http://127.0.0.1:${address.port}/`),
      addresses: ["127.0.0.1"],
    };

    server.on("connection", (socket) => {
      const pake = new Ecjpake("server", passcode);
      socket.on("message", (raw, binary) => {
        if (!binary) return;
        const frame = decodeFrame(new Uint8Array(raw as Buffer));
        if (frame.type === FrameType.ProtocolList) {
          socket.send(encodeFrame(
            FrameType.SelectedProtocol,
            new TextEncoder().encode(JSON.stringify({ protocol: "passcode", params: {} })),
          ));
          return;
        }
        if (frame.type === FrameType.EcjpakeRoundOne) {
          pake.readRoundOne(frame.payload);
          setTimeout(() => {
            if (socket.readyState === socket.OPEN) {
              socket.send(encodeFrame(FrameType.EcjpakeRoundOne, pake.writeRoundOne()));
            }
          }, 80);
        }
      });
    });

    const client = new GatewayClient(target);
    await client.start(500);
    await expect(client.authenticate(passcode, 20)).rejects.toMatchObject({
      code: "HANDSHAKE_TIMEOUT",
      details: { phase: "client-round-one-sent" },
    });
    expect(client.state).toBe("closed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.state).toBe("closed");
  });

  it("expires a pending JSON-RPC request", async () => {
    const gateway = new FakeGateway("123456", () => NO_RESPONSE);
    running.push(gateway);
    const client = new GatewayClient(await gateway.start());
    await client.start();
    await client.authenticate("123456");
    await expect(client.call("getLog", { num: 0 }, 30)).rejects.toThrow(/timed out/);
    client.close();
  });

  it("pins the validated address set and rejects lookups for another hostname", async () => {
    const target: ValidatedTarget = {
      url: new URL("http://gateway.invalid/"),
      addresses: ["127.0.0.1"],
    };
    const lookup = createPinnedLookup(target);
    const addresses = await new Promise<unknown>((resolve, reject) => {
      lookup("gateway.invalid", { all: true }, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
    expect(addresses).toEqual([{ address: "127.0.0.1", family: 4 }]);

    await expect(new Promise((resolve, reject) => {
      lookup("other.invalid", { all: false }, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    })).rejects.toMatchObject({ code: "ENOTFOUND" });
  });
});
