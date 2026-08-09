import { createHash, randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { MijiaFlowError } from "../errors.js";
import { bigIntToBytes, bytesToBigInt, concatBytes, uint32Be } from "../util/bytes.js";

type Point = InstanceType<typeof secp256k1.Point>;
type Role = "client" | "server";

const CURVE_ORDER = secp256k1.Point.Fn.ORDER;
const POINT_BYTES = 65;
const SERIALIZED_POINT_BYTES = 66;
const SERIALIZED_PROOF_BYTES = 99;
const ROUND_ONE_BYTES = 330;
const SERVER_CURVE_TAG = Uint8Array.of(3, 0, 22);

interface Proof {
  commitment: Point;
  response: bigint;
}

export type ScalarSource = () => bigint;

function mod(value: bigint): bigint {
  const result = value % CURVE_ORDER;
  return result >= 0n ? result : result + CURVE_ORDER;
}

function multiply(point: Point, scalar: bigint): Point {
  const normalized = mod(scalar);
  return normalized === 0n ? secp256k1.Point.ZERO : point.multiply(normalized);
}

function defaultScalarSource(): bigint {
  for (;;) {
    const candidate = bytesToBigInt(randomBytes(32));
    if (candidate > 0n && candidate < CURVE_ORDER) {
      return candidate;
    }
  }
}

function serializePoint(point: Point): Uint8Array {
  if (point.is0()) {
    throw new MijiaFlowError("ECJPAKE point at infinity is forbidden", "INVALID_PAKE_POINT");
  }
  const encoded = point.toBytes(false);
  if (encoded.length !== POINT_BYTES) {
    throw new MijiaFlowError("Unexpected ECJPAKE point encoding", "INVALID_PAKE_POINT");
  }
  return concatBytes(Uint8Array.of(encoded.length), encoded);
}

function parsePoint(input: Uint8Array, offset: number): { point: Point; next: number } {
  const length = input[offset];
  if (length !== POINT_BYTES || offset + 1 + length > input.length) {
    throw new MijiaFlowError("ECJPAKE point encoding is truncated", "INVALID_PAKE_POINT");
  }
  let point: Point;
  try {
    point = secp256k1.Point.fromBytes(input.subarray(offset + 1, offset + 1 + length));
    point.assertValidity();
  } catch {
    throw new MijiaFlowError("ECJPAKE point is not on secp256k1", "INVALID_PAKE_POINT");
  }
  if (point.is0()) {
    throw new MijiaFlowError("ECJPAKE point at infinity is forbidden", "INVALID_PAKE_POINT");
  }
  return { point, next: offset + 1 + length };
}

function transcriptPoint(point: Point): Uint8Array {
  const encoded = point.toBytes(false);
  return concatBytes(uint32Be(encoded.length), encoded);
}

function challenge(base: Point, commitment: Point, publicPoint: Point, identity: Role): bigint {
  const identityBytes = new TextEncoder().encode(identity);
  const transcript = concatBytes(
    transcriptPoint(base),
    transcriptPoint(commitment),
    transcriptPoint(publicPoint),
    uint32Be(identityBytes.length),
    identityBytes,
  );
  return mod(bytesToBigInt(createHash("sha256").update(transcript).digest()));
}

function generateProof(
  base: Point,
  publicPoint: Point,
  exponent: bigint,
  identity: Role,
  scalarSource: ScalarSource,
): Proof {
  const nonce = scalarSource();
  if (nonce <= 0n || nonce >= CURVE_ORDER) {
    throw new MijiaFlowError("ECJPAKE scalar source returned an invalid value", "INVALID_PAKE_SCALAR");
  }
  const commitment = base.multiply(nonce);
  const response = mod(nonce - challenge(base, commitment, publicPoint, identity) * exponent);
  return { commitment, response };
}

function verifyProof(base: Point, publicPoint: Point, proof: Proof, identity: Role): boolean {
  if (base.is0() || publicPoint.is0() || proof.commitment.is0()) {
    return false;
  }
  const c = challenge(base, proof.commitment, publicPoint, identity);
  return multiply(publicPoint, c).add(multiply(base, proof.response)).equals(proof.commitment);
}

function serializeProof(proof: Proof): Uint8Array {
  return concatBytes(serializePoint(proof.commitment), Uint8Array.of(32), bigIntToBytes(proof.response, 32));
}

function parseProof(input: Uint8Array, offset: number): { proof: Proof; next: number } {
  const parsedPoint = parsePoint(input, offset);
  const scalarLength = input[parsedPoint.next];
  if (scalarLength !== 32 || parsedPoint.next + 1 + scalarLength > input.length) {
    throw new MijiaFlowError("ECJPAKE proof scalar is truncated", "INVALID_PAKE_PROOF");
  }
  const response = bytesToBigInt(input.subarray(parsedPoint.next + 1, parsedPoint.next + 33));
  if (response >= CURVE_ORDER) {
    throw new MijiaFlowError("ECJPAKE proof scalar is non-canonical", "INVALID_PAKE_PROOF");
  }
  return {
    proof: { commitment: parsedPoint.point, response },
    next: parsedPoint.next + 33,
  };
}

export class Ecjpake {
  readonly #role: Role;
  readonly #peerRole: Role;
  readonly #passwordScalar: bigint;
  readonly #scalarSource: ScalarSource;
  #ownX1?: bigint;
  #ownX2?: bigint;
  #ownPoint1?: Point;
  #ownPoint2?: Point;
  #peerPoint1?: Point;
  #peerPoint2?: Point;
  #wroteRoundOne = false;
  #readRoundOne = false;
  #wroteRoundTwo = false;
  #readRoundTwo = false;
  #failed = false;

  constructor(role: Role, passcode: string, scalarSource: ScalarSource = defaultScalarSource) {
    if (passcode.length === 0) {
      throw new MijiaFlowError("Gateway passcode cannot be empty", "INVALID_PASSCODE");
    }
    this.#role = role;
    this.#peerRole = role === "client" ? "server" : "client";
    this.#passwordScalar = mod(bytesToBigInt(new TextEncoder().encode(passcode)));
    if (this.#passwordScalar === 0n) {
      throw new MijiaFlowError("Gateway passcode maps to an invalid scalar", "INVALID_PASSCODE");
    }
    this.#scalarSource = scalarSource;
  }

  writeRoundOne(): Uint8Array {
    this.#assertActive();
    if (this.#wroteRoundOne || this.#wroteRoundTwo || this.#readRoundTwo) {
      return this.#fail("ECJPAKE round one was requested out of order");
    }
    this.#wroteRoundOne = true;
    this.#ownX1 = this.#nextScalar();
    this.#ownX2 = this.#nextScalar();
    this.#ownPoint1 = secp256k1.Point.BASE.multiply(this.#ownX1);
    this.#ownPoint2 = secp256k1.Point.BASE.multiply(this.#ownX2);
    const proof1 = generateProof(
      secp256k1.Point.BASE,
      this.#ownPoint1,
      this.#ownX1,
      this.#role,
      this.#scalarSource,
    );
    const proof2 = generateProof(
      secp256k1.Point.BASE,
      this.#ownPoint2,
      this.#ownX2,
      this.#role,
      this.#scalarSource,
    );
    return concatBytes(
      serializePoint(this.#ownPoint1),
      serializeProof(proof1),
      serializePoint(this.#ownPoint2),
      serializeProof(proof2),
    );
  }

  readRoundOne(message: Uint8Array): void {
    this.#assertActive();
    if (this.#readRoundOne || this.#wroteRoundTwo || this.#readRoundTwo || message.length !== ROUND_ONE_BYTES) {
      return this.#fail("ECJPAKE peer round one is invalid or out of order");
    }
    this.#readRoundOne = true;
    try {
      const peer1 = parsePoint(message, 0);
      const proof1 = parseProof(message, peer1.next);
      const peer2 = parsePoint(message, proof1.next);
      const proof2 = parseProof(message, peer2.next);
      if (proof2.next !== message.length) {
        return this.#fail("ECJPAKE peer round one has trailing data");
      }
      if (!verifyProof(secp256k1.Point.BASE, peer1.point, proof1.proof, this.#peerRole)) {
        return this.#fail("ECJPAKE peer round-one proof failed");
      }
      if (!verifyProof(secp256k1.Point.BASE, peer2.point, proof2.proof, this.#peerRole)) {
        return this.#fail("ECJPAKE peer round-one proof failed");
      }
      if (this.#ownPoint1?.equals(peer1.point) || this.#ownPoint2?.equals(peer2.point)) {
        return this.#fail("ECJPAKE reflected round-one message was rejected");
      }
      this.#peerPoint1 = peer1.point;
      this.#peerPoint2 = peer2.point;
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  writeRoundTwo(): Uint8Array {
    this.#assertRoundTwoReady();
    if (this.#wroteRoundTwo) {
      return this.#fail("ECJPAKE round two was requested twice");
    }
    this.#wroteRoundTwo = true;
    const base = this.#ownPoint1!.add(this.#peerPoint1!).add(this.#peerPoint2!);
    if (base.is0()) {
      return this.#fail("ECJPAKE round-two base is the point at infinity");
    }
    const exponent = mod(this.#ownX2! * this.#passwordScalar);
    if (exponent === 0n) {
      return this.#fail("ECJPAKE round-two exponent is zero");
    }
    const publicPoint = base.multiply(exponent);
    const proof = generateProof(base, publicPoint, exponent, this.#role, this.#scalarSource);
    const body = concatBytes(serializePoint(publicPoint), serializeProof(proof));
    return this.#role === "server" ? concatBytes(SERVER_CURVE_TAG, body) : body;
  }

  readRoundTwo(message: Uint8Array): Uint8Array {
    this.#assertRoundTwoReady();
    if (this.#readRoundTwo) {
      return this.#fail("ECJPAKE peer round two was requested twice");
    }
    this.#readRoundTwo = true;
    let offset = 0;
    if (this.#role === "client") {
      if (!message.subarray(0, 3).every((value, index) => value === SERVER_CURVE_TAG[index])) {
        return this.#fail("ECJPAKE server curve identifier is invalid");
      }
      offset = 3;
    }
    try {
      const peerPublic = parsePoint(message, offset);
      const peerProof = parseProof(message, peerPublic.next);
      if (peerProof.next !== message.length) {
        return this.#fail("ECJPAKE peer round two has trailing data");
      }
      const base = this.#ownPoint1!.add(this.#ownPoint2!).add(this.#peerPoint1!);
      if (!verifyProof(base, peerPublic.point, peerProof.proof, this.#peerRole)) {
        return this.#fail("ECJPAKE peer round-two proof failed");
      }
      const ownSecretExponent = mod(this.#ownX2! * this.#passwordScalar);
      const shared = peerPublic.point
        .subtract(this.#peerPoint2!.multiply(ownSecretExponent))
        .multiply(this.#ownX2!);
      if (shared.is0()) {
        return this.#fail("ECJPAKE derived an invalid shared point");
      }
      return Uint8Array.from(createHash("sha256").update(bigIntToBytes(shared.x, 32)).digest());
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  #assertRoundTwoReady(): void {
    this.#assertActive();
    if (!this.#wroteRoundOne || !this.#readRoundOne) {
      this.#fail("ECJPAKE round two was requested before both round-one messages");
    }
  }

  #assertActive(): void {
    if (this.#failed) {
      throw new MijiaFlowError("A failed ECJPAKE context cannot be reused", "PAKE_CONTEXT_FAILED");
    }
  }

  #nextScalar(): bigint {
    const scalar = this.#scalarSource();
    if (scalar <= 0n || scalar >= CURVE_ORDER) {
      return this.#fail("ECJPAKE scalar source returned an invalid value");
    }
    return scalar;
  }

  #fail(message: string): never {
    this.#failed = true;
    throw new MijiaFlowError(message, "PAKE_FAILED");
  }
}
