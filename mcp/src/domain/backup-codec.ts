import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { MijiaFlowError } from "../errors.js";
import { compressPayload, decompressPayload } from "../protocol/compression.js";
import { canonicalJson } from "./canonical-json.js";

const backupSchema = z.object({
  version: z.literal(2),
  rules: z.array(
    z.object({
      id: z.string().min(1),
      cfg: z.record(z.string(), z.unknown()),
      nodes: z.array(z.unknown()),
    }).strict(),
  ),
  variables: z.record(z.string(), z.record(z.string(), z.unknown())),
}).strict();

export type BackupDocument = z.infer<typeof backupSchema>;

export interface DecodedBackup {
  document: BackupDocument;
  digest: string;
}

export function encodeBackup(document: BackupDocument): Uint8Array {
  const validated = backupSchema.parse(document);
  const compressed = compressPayload(new TextEncoder().encode(canonicalJson(validated)));
  const digest = createHash("sha256").update(compressed).digest();
  return Uint8Array.from(Buffer.concat([compressed, digest]));
}

export function decodeBackup(data: Uint8Array): DecodedBackup {
  if (data.length < 36) {
    throw new MijiaFlowError("Backup is too short", "INVALID_BACKUP");
  }
  const compressed = data.subarray(0, data.length - 32);
  const expected = data.subarray(data.length - 32);
  const actual = createHash("sha256").update(compressed).digest();
  if (!timingSafeEqual(expected, actual)) {
    throw new MijiaFlowError("Backup SHA-256 digest does not match", "INVALID_BACKUP_DIGEST");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decompressPayload(compressed)));
  } catch (error) {
    if (error instanceof MijiaFlowError) {
      throw error;
    }
    throw new MijiaFlowError("Backup JSON is invalid", "INVALID_BACKUP");
  }
  const parsed = backupSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new MijiaFlowError("Backup schema is invalid", "INVALID_BACKUP", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return { document: parsed.data, digest: actual.toString("hex") };
}
