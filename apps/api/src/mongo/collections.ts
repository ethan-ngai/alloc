/**
 * Shared `$jsonSchema` fragments and collection provisioning. Fragments mirror
 * the strict 1A contract patterns so a document that would fail Zod validation
 * cannot be stored either. Domain modules own their collection specs and call
 * `ensureCollections`.
 */
import type { Db, IndexDescription } from "mongodb";
import {
  CLASSIFICATIONS, DATE_PATTERN, ID_PATTERN, MAX_SAFE_INTEGER, MIN_SAFE_INTEGER,
  ORGANIZATION_ID_PATTERN, SCOPE_TYPES, TIMESTAMP_PATTERN,
} from "./patterns.js";

export const ORG_ID = { bsonType: "string", pattern: ORGANIZATION_ID_PATTERN } as const;
export const ID = { bsonType: "string", pattern: ID_PATTERN } as const;
export const TIMESTAMP = { bsonType: "string", pattern: TIMESTAMP_PATTERN } as const;
export const DATE = { bsonType: "string", pattern: DATE_PATTERN } as const;
export const REVISION = { bsonType: ["int", "long", "double"], minimum: 1, maximum: MAX_SAFE_INTEGER, multipleOf: 1 } as const;
export const NON_NEGATIVE_INT = { bsonType: ["int", "long", "double"], minimum: 0, maximum: MAX_SAFE_INTEGER, multipleOf: 1 } as const;
export const SIGNED_INT = { bsonType: ["int", "long", "double"], minimum: MIN_SAFE_INTEGER, maximum: MAX_SAFE_INTEGER, multipleOf: 1 } as const;
export const REVISION_OR_NULL = { anyOf: [REVISION, { bsonType: "null" }] } as const;
export const TIMESTAMP_OR_NULL = { anyOf: [TIMESTAMP, { bsonType: "null" }] } as const;
export const NON_EMPTY_STRING = { bsonType: "string", minLength: 1 } as const;

export function money(minimum: number, maximum = MAX_SAFE_INTEGER) {
  return {
    bsonType: "object",
    additionalProperties: false,
    required: ["amountMinor", "currency"],
    properties: {
      amountMinor: { bsonType: ["int", "long", "double"], minimum, maximum, multipleOf: 1 },
      currency: { enum: ["USD"] },
    },
  };
}

export const NON_NEGATIVE_MONEY = money(0);
export const POSITIVE_MONEY = money(1);
export const SIGNED_MONEY = money(MIN_SAFE_INTEGER);
export const SIGNED_NON_ZERO_MONEY = {
  bsonType: "object",
  additionalProperties: false,
  required: ["amountMinor", "currency"],
  properties: {
    amountMinor: { anyOf: [money(MIN_SAFE_INTEGER, -1).properties.amountMinor, money(1).properties.amountMinor] },
    currency: { enum: ["USD"] },
  },
};

export const RECORD_REF = {
  bsonType: "object",
  additionalProperties: false,
  required: ["type", "id"],
  properties: { type: NON_EMPTY_STRING, id: ID, revision: REVISION },
};

export const SCOPE_REF = {
  bsonType: "object",
  additionalProperties: false,
  required: ["type", "id"],
  properties: { type: { enum: [...SCOPE_TYPES] }, id: ID },
};

export const SCOPES = { bsonType: "array", minItems: 1, items: SCOPE_REF };

export const PROVENANCE = {
  bsonType: "object",
  additionalProperties: false,
  required: ["kind", "trust", "sourceInstanceId", "sourceObjectId", "sourceRevision", "occurredAt", "observedAt"],
  properties: {
    kind: { enum: ["synthetic", "imported", "live"] },
    trust: { enum: ["authoritative", "evidence", "candidate"] },
    sourceInstanceId: ID,
    sourceObjectId: NON_EMPTY_STRING,
    sourceRevision: NON_EMPTY_STRING,
    occurredAt: TIMESTAMP,
    observedAt: TIMESTAMP,
  },
};

export const ACCESS = {
  bsonType: "object",
  additionalProperties: false,
  required: ["classification", "scopeRefs"],
  properties: {
    classification: { enum: [...CLASSIFICATIONS] },
    scopeRefs: SCOPES,
    allowedPrincipalIds: { bsonType: "array", items: ID },
  },
};

export const POLICY_RULE = {
  bsonType: "object",
  additionalProperties: false,
  required: ["ruleId", "effect", "categoryIds", "requesterRoles", "requireActivePurpose", "requiredEvidenceKinds"],
  properties: {
    ruleId: ID,
    effect: { enum: ["permit", "deny", "require_review"] },
    categoryIds: { bsonType: "array", minItems: 1, items: ID },
    requesterRoles: { bsonType: "array", minItems: 1, items: NON_EMPTY_STRING },
    maximumFullAmount: NON_NEGATIVE_MONEY,
    maximumCumulativeIncrease: NON_NEGATIVE_MONEY,
    requireActivePurpose: { bsonType: "bool" },
    requiredEvidenceKinds: { bsonType: "array", items: NON_EMPTY_STRING },
    eligibleVendorIds: { bsonType: "array", minItems: 1, items: ID },
    maximumEvidenceAgeSeconds: NON_NEGATIVE_INT,
    requiredApproverRole: NON_EMPTY_STRING,
    prohibitRequesterApproval: { bsonType: "bool" },
    cumulativeLimitScope: { enum: ["employee", "purpose", "project"] },
  },
};

export interface CollectionSpec {
  readonly name: string;
  readonly validator: Record<string, unknown>;
  readonly indexes: readonly IndexDescription[];
}

export function schema(required: readonly string[], properties: Record<string, unknown>): Record<string, unknown> {
  return {
    $jsonSchema: {
      bsonType: "object",
      additionalProperties: false,
      required: ["_id", ...required],
      properties: { _id: { bsonType: "objectId" }, ...properties },
    },
  };
}

async function ensureCollection(db: Db, spec: CollectionSpec): Promise<void> {
  const options = { validator: spec.validator, validationLevel: "strict", validationAction: "error" } as const;
  const exists = await db.listCollections({ name: spec.name }, { nameOnly: true }).hasNext();
  if (exists) {
    await db.command({ collMod: spec.name, ...options });
  } else {
    try {
      await db.createCollection(spec.name, options);
    } catch (error) {
      if ((error as { codeName?: unknown } | null)?.codeName !== "NamespaceExists") {
        throw error;
      }
      await db.command({ collMod: spec.name, ...options });
    }
  }
  await db.collection(spec.name).createIndexes([...spec.indexes]);
}

/** Creates or revalidates each collection and its indexes. Idempotent. */
export async function ensureCollections(db: Db, specs: readonly CollectionSpec[]): Promise<void> {
  for (const spec of specs) {
    await ensureCollection(db, spec);
  }
}
