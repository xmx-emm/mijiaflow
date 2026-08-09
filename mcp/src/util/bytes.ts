export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  if (bytes.length === 0) {
    return 0n;
  }
  return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

export function bigIntToBytes(value: bigint, length: number): Uint8Array {
  if (value < 0n) {
    throw new RangeError("Cannot encode a negative integer");
  }
  const hex = value.toString(16).padStart(length * 2, "0");
  if (hex.length > length * 2) {
    throw new RangeError(`Integer does not fit in ${length} bytes`);
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

export function uint32Le(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

export function uint32Be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

export function readUint32Le(bytes: Uint8Array, offset = 0): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new RangeError("Truncated uint32");
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

export function wipe(bytes: Uint8Array | undefined): void {
  bytes?.fill(0);
}
