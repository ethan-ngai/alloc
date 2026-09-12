/**
 * Shared `$jsonSchema` fragments. They mirror the strict 1A contract patterns so
 * a document that would fail Zod validation cannot be stored either.
 */

export const ID_PATTERN = "^[a-z][a-z0-9]*(_[a-z0-9]+)+$";
export const ORGANIZATION_ID_PATTERN = "^org_[a-z0-9]+(_[a-z0-9]+)*$";
export const TIMESTAMP_PATTERN =
  "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]+)?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$";
export const DATE_PATTERN = "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$";

export const SCOPE_TYPES = [
  "organization",
  "department",
  "project",
  "category",
  "location",
  "vendor",
  "employee",
  "customer",
  "asset",
  "contract",
  "legal_entity",
  "account",
] as const;

export const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;

export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
export const MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
