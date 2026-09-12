import { z } from "zod";

export const CONTRACT_SCHEMA_VERSION = "1.0.0" as const;
export const ContractSchemaVersionSchema = z.literal(CONTRACT_SCHEMA_VERSION);

export const IdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/, "expected a stable prefixed ID");
export const OrganizationIdSchema = z.string().regex(/^org_[a-z0-9]+(?:_[a-z0-9]+)*$/, "expected an organization ID");
export const RevisionSchema = z.number().int().positive().safe();
export const TimestampSchema = z.iso.datetime({ offset: true });
export const DateSchema = z.iso.date();
export const PrioritySchema = z.enum(["P0", "P1", "P2"]);
export const DataClassificationSchema = z.enum(["public", "internal", "confidential", "restricted"]);
export const ProvenanceKindSchema = z.enum(["synthetic", "imported", "live"]);
export const TrustLevelSchema = z.enum(["authoritative", "evidence", "candidate"]);

export const NonNegativeMoneySchema = z.strictObject({
  amountMinor: z.number().int().safe().nonnegative(),
  currency: z.literal("USD"),
});

export const PositiveMoneySchema = z.strictObject({
  amountMinor: z.number().int().safe().positive(),
  currency: z.literal("USD"),
});

export const SignedMoneySchema = z.strictObject({
  amountMinor: z.number().int().safe(),
  currency: z.literal("USD"),
});

export const SignedNonZeroMoneySchema = z.strictObject({
  amountMinor: z.union([
    z.number().int().safe().max(-1),
    z.number().int().safe().min(1),
  ]),
  currency: z.literal("USD"),
});

export const RecordRefSchema = z.strictObject({
  type: z.string().min(1),
  id: IdSchema,
  revision: RevisionSchema.optional(),
});

export const ScopeRefSchema = z.strictObject({
  type: z.enum([
    "organization", "department", "project", "category", "location", "vendor",
    "employee", "customer", "asset", "contract", "legal_entity", "account",
  ]),
  id: IdSchema,
});

export const AccessScopeSchema = z.strictObject({
  classification: DataClassificationSchema,
  scopeRefs: z.array(ScopeRefSchema).min(1),
  allowedPrincipalIds: z.array(IdSchema).default([]),
});

export const ProvenanceSchema = z.strictObject({
  kind: ProvenanceKindSchema,
  trust: TrustLevelSchema,
  sourceInstanceId: IdSchema,
  sourceObjectId: z.string().min(1),
  sourceRevision: z.string().min(1),
  occurredAt: TimestampSchema,
  observedAt: TimestampSchema,
});

export const PageRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});

export const PageInfoSchema = z.strictObject({
  nextCursor: z.string().min(1).nullable(),
  truncated: z.boolean(),
});

export const ErrorCodeSchema = z.enum([
  "VALIDATION_FAILED", "NOT_FOUND", "ACCESS_DENIED", "AUTHORITY_DENIED",
  "STALE_VERSION", "IDEMPOTENCY_CONFLICT", "POLICY_DENIED", "REVIEW_REQUIRED",
  "CAPACITY_EXCEEDED", "OUTCOME_UNKNOWN", "SOURCE_DUPLICATE", "SOURCE_CONFLICT",
  "DEPENDENCY_UNAVAILABLE", "INTERNAL_ERROR",
]);

export const ContractErrorSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  code: ErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  correlationId: IdSchema,
  details: z.record(z.string(), z.unknown()).optional(),
});

export const VersionExpectationSchema = z.strictObject({
  ref: RecordRefSchema.omit({ revision: true }),
  expectedRevision: RevisionSchema,
});

export const CommandMetaSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  commandId: IdSchema,
  correlationId: IdSchema,
  causationId: IdSchema.optional(),
  expectedVersions: z.array(VersionExpectationSchema),
});

export type Money = z.infer<typeof NonNegativeMoneySchema>;
export type SignedMoney = z.infer<typeof SignedMoneySchema>;
export type ContractError = z.infer<typeof ContractErrorSchema>;
