import { createHash } from "node:crypto";

/**
 * Key-sorted JSON so a fingerprint depends on meaning, not property order. Used
 * for command payload comparison and deterministic record identity.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) {
        sorted[key] = sortValue(record[key]);
      }
    }
    return sorted;
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Deterministic contract-valid ID: `<prefix>_<24 hex chars>`. */
export function recordId(prefix: string, ...parts: readonly unknown[]): string {
  return `${prefix}_${fingerprint(parts).slice(0, 24)}`;
}
