import { z } from "zod";
import {
  ContractSchemaVersionSchema, IdSchema, OrganizationIdSchema, RecordRefSchema, RevisionSchema, TimestampSchema,
} from "./common.js";
import { ActionReceiptSchema, DecisionSchema, PostingSchema, PurchaseRequestRevisionSchema } from "./financial.js";
import { ForecastSnapshotSchema } from "./runtime.js";

const EventMetaShape = {
  schemaVersion: ContractSchemaVersionSchema,
  eventId: IdSchema,
  organizationId: OrganizationIdSchema,
  aggregateRef: RecordRefSchema,
  aggregateRevision: RevisionSchema,
  correlationId: IdSchema,
  causationId: IdSchema.optional(),
  occurredAt: TimestampSchema,
};

export const RequestRevisedEventSchema = z.strictObject({ ...EventMetaShape, eventType: z.literal("request.revised"), payload: PurchaseRequestRevisionSchema });
export const DecisionRecordedEventSchema = z.strictObject({ ...EventMetaShape, eventType: z.literal("decision.recorded"), payload: DecisionSchema });
export const ActionReconciledEventSchema = z.strictObject({ ...EventMetaShape, eventType: z.literal("action.reconciled"), payload: ActionReceiptSchema });
export const PostingRecordedEventSchema = z.strictObject({ ...EventMetaShape, eventType: z.literal("posting.recorded"), payload: PostingSchema });
export const ForecastCompletedEventSchema = z.strictObject({ ...EventMetaShape, eventType: z.literal("forecast.completed"), payload: ForecastSnapshotSchema });

export const EventEnvelopeSchema = z.discriminatedUnion("eventType", [
  RequestRevisedEventSchema, DecisionRecordedEventSchema, ActionReconciledEventSchema,
  PostingRecordedEventSchema, ForecastCompletedEventSchema,
]);

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
