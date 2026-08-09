import { MijiaFlowError } from "../errors.js";
import { concatBytes } from "../util/bytes.js";

export enum FrameType {
  ProtocolList = 1,
  SelectedProtocol = 2,
  SessionKeyExchange = 3,
  Error = 4,
  Data = 5,
  ServerPublicKey = 16,
  EcjpakeRoundOne = 32,
  EcjpakeRoundTwo = 33,
}

const KNOWN_TYPES = new Set<number>(Object.values(FrameType).filter((value) => typeof value === "number"));
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export interface GatewayFrame {
  type: FrameType;
  payload: Uint8Array;
}

export function encodeFrame(
  type: FrameType,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
): Uint8Array {
  if (!KNOWN_TYPES.has(type)) {
    throw new MijiaFlowError(`Unknown frame type: ${type}`, "INVALID_FRAME");
  }
  if (payload.length + 1 > MAX_FRAME_BYTES) {
    throw new MijiaFlowError("Gateway frame exceeds the size limit", "FRAME_TOO_LARGE");
  }
  return concatBytes(Uint8Array.of(type), payload);
}

export function decodeFrame(data: Uint8Array): GatewayFrame {
  if (data.length === 0) {
    throw new MijiaFlowError("Gateway frame is empty", "INVALID_FRAME");
  }
  if (data.length > MAX_FRAME_BYTES) {
    throw new MijiaFlowError("Gateway frame exceeds the size limit", "FRAME_TOO_LARGE");
  }
  const type = data[0];
  if (type === undefined || !KNOWN_TYPES.has(type)) {
    throw new MijiaFlowError(`Unknown frame type: ${type ?? "missing"}`, "INVALID_FRAME");
  }
  return { type: type as FrameType, payload: data.slice(1) };
}
