import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AeadChannel } from "../src/protocol/aead-channel.js";
import { compressPayload, decompressPayload } from "../src/protocol/compression.js";
import { Ecjpake } from "../src/protocol/ecjpake.js";
import { decodeFrame, encodeFrame, FrameType } from "../src/protocol/frame-codec.js";

function scalarSequence(start: bigint): () => bigint {
  let value = start;
  return () => value++;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("gateway binary protocol primitives", () => {
  it("round-trips typed frames and rejects malformed input", () => {
    const encoded = encodeFrame(FrameType.Data, Uint8Array.of(1, 2, 3));
    expect(decodeFrame(encoded)).toEqual({ type: FrameType.Data, payload: Uint8Array.of(1, 2, 3) });
    expect(() => decodeFrame(new Uint8Array())).toThrow(/empty/);
    expect(() => decodeFrame(Uint8Array.of(255))).toThrow(/Unknown frame type/);
  });

  it("uses the Mijia length-prefixed raw-DEFLATE payload format", () => {
    const input = new TextEncoder().encode('{"jsonrpc":"2.0","id":1}');
    const compressed = compressPayload(input);
    expect(new DataView(compressed.buffer, compressed.byteOffset).getUint32(0, true)).toBe(input.length);
    expect(decompressPayload(compressed)).toEqual(input);
    const tampered = compressed.slice();
    new DataView(tampered.buffer).setUint32(0, input.length + 1, true);
    expect(() => decompressPayload(tampered)).toThrow(/length prefix/);
  });

  it("decodes an independent raw-DEFLATE vector", () => {
    const vector = Uint8Array.from(Buffer.from("02000000abae0500", "hex"));
    expect(decompressPayload(vector)).toEqual(new TextEncoder().encode("{}"));
  });

  it("authenticates AES-128-GCM frames, tracks counters, and rejects replay", () => {
    const key = Uint8Array.from({ length: 16 }, (_, index) => index);
    const salt = Uint8Array.from({ length: 8 }, (_, index) => 0xa0 + index);
    const sender = new AeadChannel(key, salt);
    const receiver = new AeadChannel(key, salt);
    const plaintext = new TextEncoder().encode("mijiaflow");
    const encrypted = sender.encrypt(plaintext);
    expect(new DataView(encrypted.buffer, encrypted.byteOffset).getUint32(0, true)).toBe(1);
    expect(receiver.decrypt(encrypted)).toEqual(plaintext);
    expect(() => receiver.decrypt(encrypted)).toThrow(/replayed/);

    const skipped = sender.encrypt(plaintext);
    const skippedReceiver = new AeadChannel(key, salt);
    expect(skippedReceiver.decrypt(skipped)).toEqual(plaintext);
    expect(() => skippedReceiver.decrypt(encrypted)).toThrow(/replayed/);

    const tampered = new AeadChannel(key, salt).encrypt(plaintext);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => new AeadChannel(key, salt).decrypt(tampered)).toThrow(/authentication failed/);
  });

  it("derives identical ECJPAKE session material for independent roles", () => {
    const client = new Ecjpake("client", "246810", scalarSequence(11n));
    const server = new Ecjpake("server", "246810", scalarSequence(101n));
    const clientRoundOne = client.writeRoundOne();
    server.readRoundOne(clientRoundOne);
    const serverRoundOne = server.writeRoundOne();
    client.readRoundOne(serverRoundOne);
    const clientRoundTwo = client.writeRoundTwo();
    const serverRoundTwo = server.writeRoundTwo();
    const clientSecret = client.readRoundTwo(serverRoundTwo);
    const serverSecret = server.readRoundTwo(clientRoundTwo);
    expect(clientSecret).toEqual(serverSecret);
    expect(clientSecret).toHaveLength(32);
  });

  it("matches the fixed v1.6.1 ECJPAKE transcript", () => {
    const client = new Ecjpake("client", "246810", scalarSequence(11n));
    const server = new Ecjpake("server", "246810", scalarSequence(101n));
    const clientRoundOne = client.writeRoundOne();
    server.readRoundOne(clientRoundOne);
    const serverRoundOne = server.writeRoundOne();
    client.readRoundOne(serverRoundOne);
    const clientRoundTwo = client.writeRoundTwo();
    const serverRoundTwo = server.writeRoundTwo();
    const clientSecret = client.readRoundTwo(serverRoundTwo);
    const serverSecret = server.readRoundTwo(clientRoundTwo);

    expect([
      sha256(clientRoundOne),
      sha256(serverRoundOne),
      sha256(clientRoundTwo),
      sha256(serverRoundTwo),
    ]).toEqual([
      "f5f1173693845f2243346dd6d5047d4a7bdecb515ef2fa29345e1f8f6afa3b85",
      "3f87be07e796b9f7a3e40d050b1c5748fccbabbbf19583c0f3ac57038bd02fb7",
      "3b3c53deb5d336a6c0cf91a658b8a7a85fcc218278859553c4dec6e1fc2f1ffc",
      "12b1d08042ac35bcb385a8ae85fa2dbca71ac5475519b2095c0861d061b643a9",
    ]);
    expect(Buffer.from(clientSecret).toString("hex")).toBe(
      "0446915a1472de5cf592a2d332b49d6403324898fc5c7e235e1a4337a9b340e4",
    );
    expect(serverSecret).toEqual(clientSecret);
  });

  it("turns a wrong passcode into distinct authenticated session material", () => {
    const client = new Ecjpake("client", "correct", scalarSequence(31n));
    const server = new Ecjpake("server", "wrong", scalarSequence(211n));
    const clientRoundOne = client.writeRoundOne();
    server.readRoundOne(clientRoundOne);
    const serverRoundOne = server.writeRoundOne();
    client.readRoundOne(serverRoundOne);
    const clientRoundTwo = client.writeRoundTwo();
    const serverRoundTwo = server.writeRoundTwo();
    const clientSecret = client.readRoundTwo(serverRoundTwo);
    const serverSecret = server.readRoundTwo(clientRoundTwo);
    expect(clientSecret).not.toEqual(serverSecret);
    const encrypted = new AeadChannel(clientSecret.subarray(0, 16), clientSecret.subarray(16, 24))
      .encrypt(Uint8Array.of(1));
    expect(() => new AeadChannel(serverSecret.subarray(0, 16), serverSecret.subarray(16, 24)).decrypt(encrypted))
      .toThrow(/authentication failed/);
  });

  it("matches fixed AES-GCM vectors for salt plus little-endian counter nonces", () => {
    const key = new Uint8Array(16);
    const salt = new Uint8Array(8);
    const empty = new AeadChannel(key, salt).encrypt(new Uint8Array());
    expect(Buffer.from(empty).toString("hex")).toBe(
      "01000000b58a8be6ce1850257b806ec5e2b9e860",
    );

    const block = new AeadChannel(key, salt).encrypt(new Uint8Array(16));
    expect(Buffer.from(block).toString("hex")).toBe(
      "010000004661d681f92680d7a45e9fbeae6b6383c7d569da934cc4c33d78125d82445fcc",
    );
  });
});
