import { z } from "zod";
import {
  CommandMetaSchema, ContractErrorSchema, ContractSchemaVersionSchema, IdSchema, NonNegativeMoneySchema,
  OrganizationIdSchema, PageInfoSchema, PageRequestSchema, PositiveMoneySchema, RecordRefSchema,
  RevisionSchema, ScopeRefSchema, TimestampSchema,
} from "./common.js";
import {
  ApprovalGrantSchema, CommitmentSchema, DecisionSchema, PostingCorrectionSchema, PostingSchema,
  PurchaseRequestRevisionSchema,
} from "./financial.js";
import { MemoryResponseSchema, SourceDeliverySchema } from "./memory.js";
import { DurableJobMessageSchema, ForecastAssumptionSchema, ForecastSnapshotSchema } from "./runtime.js";

export const QueryMetaSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  correlationId: IdSchema,
});

export function operationResult<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), schemaVersion: ContractSchemaVersionSchema, correlationId: IdSchema, data }),
    z.strictObject({ ok: z.literal(false), schemaVersion: ContractSchemaVersionSchema, correlationId: IdSchema, error: ContractErrorSchema }),
  ]);
}

export const CreateRequestInputSchema = z.strictObject({
  meta: CommandMetaSchema,
  payload: z.strictObject({
    requesterId: IdSchema,
    purpose: z.string().min(1),
    fullAmount: PositiveMoneySchema,
    categoryId: IdSchema,
    vendorId: IdSchema.optional(),
    projectId: IdSchema.optional(),
    scopes: z.array(ScopeRefSchema).min(1),
  }),
});
export const CreateRequestResultSchema = operationResult(PurchaseRequestRevisionSchema);

export const AmendRequestInputSchema = z.strictObject({
  meta: CommandMetaSchema,
  payload: z.strictObject({ requestId: IdSchema, revisedFullAmount: PositiveMoneySchema, reason: z.string().min(1) }),
});
export const AmendRequestResultSchema = operationResult(z.strictObject({ request: PurchaseRequestRevisionSchema, decision: DecisionSchema }));

export const GetRequestInputSchema = z.strictObject({ meta: QueryMetaSchema, payload: z.strictObject({ requestId: IdSchema }) });
export const GetRequestResultSchema = operationResult(z.strictObject({ request: PurchaseRequestRevisionSchema, decisions: z.array(DecisionSchema), commitment: CommitmentSchema.nullable() }));

export const DecideReviewInputSchema = z.strictObject({
  meta: CommandMetaSchema,
  payload: z.strictObject({ requestId: IdSchema, requestRevision: RevisionSchema, outcome: z.enum(["approved", "denied"]), rationale: z.string().min(1), grant: ApprovalGrantSchema.optional() }),
});
export const DecideReviewResultSchema = operationResult(z.strictObject({ decision: DecisionSchema, commitment: CommitmentSchema.nullable() }));

export const RecordPostingInputSchema = z.strictObject({ meta: CommandMetaSchema, payload: PostingSchema.omit({ organizationId: true, schemaVersion: true }) });
export const RecordPostingResultSchema = operationResult(PostingSchema);
export const CorrectPostingInputSchema = z.strictObject({ meta: CommandMetaSchema, payload: PostingCorrectionSchema.omit({ organizationId: true, schemaVersion: true }) });
export const CorrectPostingResultSchema = operationResult(PostingCorrectionSchema);

export const IngestSourceInputSchema = z.strictObject({ meta: CommandMetaSchema, payload: SourceDeliverySchema.omit({ organizationId: true, schemaVersion: true }) });
export const IngestSourceResultSchema = operationResult(z.strictObject({ deliveryRef: RecordRefSchema, disposition: z.enum(["accepted", "duplicate", "quarantined"]), normalizedRefs: z.array(RecordRefSchema) }));

export const QueryMemoryInputSchema = z.strictObject({
  meta: QueryMetaSchema,
  payload: z.strictObject({ query: z.string().min(1), scopes: z.array(ScopeRefSchema).min(1), asOf: TimestampSchema.optional(), page: PageRequestSchema }),
});
export const QueryMemoryResultSchema = operationResult(MemoryResponseSchema);

export const RunForecastInputSchema = z.strictObject({
  meta: CommandMetaSchema,
  payload: z.strictObject({ scope: ScopeRefSchema, asOfCutoff: TimestampSchema, horizonEnd: TimestampSchema, assumptions: z.array(ForecastAssumptionSchema) }),
});
export const RunForecastResultSchema = operationResult(z.strictObject({ job: DurableJobMessageSchema, acceptedAt: TimestampSchema }));
export const GetForecastInputSchema = z.strictObject({ meta: QueryMetaSchema, payload: z.strictObject({ forecastId: IdSchema }) });
export const GetForecastResultSchema = operationResult(ForecastSnapshotSchema);

export const ListActivityInputSchema = z.strictObject({
  meta: QueryMetaSchema,
  payload: z.strictObject({ scopes: z.array(ScopeRefSchema), since: TimestampSchema.optional(), page: PageRequestSchema }),
});
export const ActivityItemSchema = z.strictObject({
  activityId: IdSchema,
  type: z.enum(["request", "decision", "posting", "source", "job", "forecast", "action"]),
  occurredAt: TimestampSchema,
  subjectRef: RecordRefSchema,
  summary: z.string().min(1),
});
export const ListActivityResultSchema = operationResult(z.strictObject({ items: z.array(ActivityItemSchema), page: PageInfoSchema }));

export const OperationSchemas = {
  "requests.create": { input: CreateRequestInputSchema, result: CreateRequestResultSchema },
  "requests.amend": { input: AmendRequestInputSchema, result: AmendRequestResultSchema },
  "requests.get": { input: GetRequestInputSchema, result: GetRequestResultSchema },
  "reviews.decide": { input: DecideReviewInputSchema, result: DecideReviewResultSchema },
  "postings.record": { input: RecordPostingInputSchema, result: RecordPostingResultSchema },
  "postings.correct": { input: CorrectPostingInputSchema, result: CorrectPostingResultSchema },
  "imports.ingest": { input: IngestSourceInputSchema, result: IngestSourceResultSchema },
  "memory.query": { input: QueryMemoryInputSchema, result: QueryMemoryResultSchema },
  "forecasts.run": { input: RunForecastInputSchema, result: RunForecastResultSchema },
  "forecasts.get": { input: GetForecastInputSchema, result: GetForecastResultSchema },
  "activity.list": { input: ListActivityInputSchema, result: ListActivityResultSchema },
} as const;

export type CreateRequestInput = z.infer<typeof CreateRequestInputSchema>;
export type AmendRequestInput = z.infer<typeof AmendRequestInputSchema>;
export type DecideReviewInput = z.infer<typeof DecideReviewInputSchema>;
export type QueryMemoryInput = z.infer<typeof QueryMemoryInputSchema>;
export type OperationName = keyof typeof OperationSchemas;
export type OperationInput<Name extends OperationName> = z.infer<(typeof OperationSchemas)[Name]["input"]>;
export type OperationResult<Name extends OperationName> = z.infer<(typeof OperationSchemas)[Name]["result"]>;
