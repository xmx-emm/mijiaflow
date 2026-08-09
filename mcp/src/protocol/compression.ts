import { deflateRawSync, inflateRawSync } from "node:zlib";
import { MijiaFlowError } from "../errors.js";
import { concatBytes, readUint32Le, uint32Le } from "../util/bytes.js";

export const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;

export function compressPayload(input: Uint8Array): Uint8Array {
  if (input.length > MAX_PLAINTEXT_BYTES) {
    throw new MijiaFlowError("Plaintext exceeds the compression limit", "PAYLOAD_TOO_LARGE");
  }
  return concatBytes(uint32Le(input.length), deflateRawSync(input));
}

export function decompressPayload(input: Uint8Array): Uint8Array {
  if (input.length < 4) {
    throw new MijiaFlowError("Compressed payload is truncated", "INVALID_COMPRESSION");
  }
  const expectedLength = readUint32Le(input);
  if (expectedLength > MAX_PLAINTEXT_BYTES) {
    throw new MijiaFlowError("Declared plaintext exceeds the decompression limit", "PAYLOAD_TOO_LARGE");
  }
  let inflated: Buffer;
  try {
    inflated = inflateRawSync(input.subarray(4), { maxOutputLength: MAX_PLAINTEXT_BYTES });
  } catch {
    throw new MijiaFlowError("Raw DEFLATE payload is invalid", "INVALID_COMPRESSION");
  }
  if (inflated.length !== expectedLength) {
    throw new MijiaFlowError("Compressed payload length prefix does not match", "INVALID_COMPRESSION");
  }
  return Uint8Array.from(inflated);
}
