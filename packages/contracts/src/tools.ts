import { z } from "zod";
import {
  ContractSchemaVersionSchema, IdSchema, NonNegativeMoneySchema, OrganizationIdSchema, PageRequestSchema,
  PositiveMoneySchema, PrioritySchema, RecordRefSchema, RevisionSchema, ScopeRefSchema, TimestampSchema,
} from "./common.js";
import { PurchaseRequestRevisionSchema } from "./financial.js";
import { EvidenceSchema, MemoryResponseSchema } from "./memory.js";
import { ForecastAssumptionSchema, ForecastSnapshotSchema } from "./runtime.js";

// This context is injected and authenticated by the backend. It is never accepted
// as part of model-supplied tool arguments.
export const ToolExecutionContextSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  principalId: IdSchema,
  serviceIdentityId: IdSchema,
  authorityGrantRefs: z.array(RecordRefSchema),
  allowedScopes: z.array(ScopeRefSchema).min(1),
  priority: PrioritySchema,
  jobId: IdSchema,
  leaseGeneration: RevisionSchema,
  leaseExpiresAt: TimestampSchema,
});

export const GetRequestToolInputSchema = z.strictObject({ requestId: IdSchema });
export const GetRequestToolResultSchema = z.strictObject({ request: PurchaseRequestRevisionSchema, current: z.boolean() });

export const GetContextToolInputSchema = z.strictObject({
  subjectRef: RecordRefSchema.omit({ revision: true }),
  relationshipTypes: z.array(z.string().min(1)).max(10),
  maxHops: z.number().int().min(0).max(2).default(2),
  maxEntities: z.number().int().min(1).max(50).default(50),
});
export const GetContextToolResultSchema = MemoryResponseSchema;

export const SearchEvidenceToolInputSchema = z.strictObject({
  query: z.string().min(1).max(500),
  scopes: z.array(ScopeRefSchema).min(1),
  kinds: z.array(z.string().min(1)).max(10),
  page: PageRequestSchema,
});
export const SearchEvidenceToolResultSchema = z.strictObject({ evidence: z.array(EvidenceSchema).max(8), truncated: z.boolean(), continuation: z.string().nullable() });

export const RunForecastToolInputSchema = z.strictObject({
  scope: ScopeRefSchema,
  asOfCutoff: TimestampSchema,
  horizonEnd: TimestampSchema,
  assumptions: z.array(ForecastAssumptionSchema).max(20),
});
export const RunForecastToolResultSchema = z.strictObject({ forecast: ForecastSnapshotSchema, calculatedBy: z.literal("deterministic_backend") });

export const ProposeActionToolInputSchema = z.strictObject({
  requestId: IdSchema,
  requestRevision: RevisionSchema,
  type: z.enum(["simulate_purchase", "request_human_review", "cancel_request"]),
  amount: PositiveMoneySchema.optional(),
  rationale: z.string().min(1).max(2_000),
  evidenceRefs: z.array(RecordRefSchema).max(20),
});
export const ProposeActionToolResultSchema = z.strictObject({
  proposalId: IdSchema,
  disposition: z.enum(["accepted_for_evaluation", "rejected", "review_required"]),
  reasonCodes: z.array(z.string().min(1)),
  createsFinancialEffect: z.literal(false),
});

export const ToolSchemas = {
  get_request: { input: GetRequestToolInputSchema, result: GetRequestToolResultSchema },
  get_context: { input: GetContextToolInputSchema, result: GetContextToolResultSchema },
  search_evidence: { input: SearchEvidenceToolInputSchema, result: SearchEvidenceToolResultSchema },
  run_forecast: { input: RunForecastToolInputSchema, result: RunForecastToolResultSchema },
  propose_action: { input: ProposeActionToolInputSchema, result: ProposeActionToolResultSchema },
} as const;

export type ToolExecutionContext = z.infer<typeof ToolExecutionContextSchema>;
export type ProposeActionToolInput = z.infer<typeof ProposeActionToolInputSchema>;
export type ToolName = keyof typeof ToolSchemas;
export type ToolInput<Name extends ToolName> = z.infer<(typeof ToolSchemas)[Name]["input"]>;
export type ToolResult<Name extends ToolName> = z.infer<(typeof ToolSchemas)[Name]["result"]>;
