import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export interface JsonDiffEntry {
  path: string;
  before?: unknown;
  after?: unknown;
}

export function diffJson(before: unknown, after: unknown, path = "$"): JsonDiffEntry[] {
  if (canonicalJson(before) === canonicalJson(after)) {
    return [];
  }
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) => diffJson(left[key], right[key], `${path}.${key}`));
  }
  const entry: JsonDiffEntry = { path };
  if (before !== undefined) {
    entry.before = before;
  }
  if (after !== undefined) {
    entry.after = after;
  }
  return [entry];
}
