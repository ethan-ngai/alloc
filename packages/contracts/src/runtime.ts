import { z } from "zod";
import {
  ContractSchemaVersionSchema, IdSchema, NonNegativeMoneySchema, OrganizationIdSchema,
  PrioritySchema, RecordRefSchema, RevisionSchema, ScopeRefSchema, SignedMoneySchema,
  SignedNonZeroMoneySchema, TimestampSchema,
} from "./common.js";

const ForecastAssumptionShape = {
  assumptionId: IdSchema,
  name: z.string().min(1),
  scope: ScopeRefSchema,
  effectiveFrom: TimestampSchema,
  effectiveTo: TimestampSchema,
  evidenceRefs: z.array(RecordRefSchema),
};

export const ForecastAssumptionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...ForecastAssumptionShape,
    kind: z.literal("fixed_adjustment"),
    amount: SignedNonZeroMoneySchema,
  }),
  z.strictObject({
    ...ForecastAssumptionShape,
    kind: z.literal("percentage_change"),
    valueBasisPoints: z.union([
      z.number().int().safe().min(-10_000).max(-1),
      z.number().int().safe().min(1).max(100_000),
    ]),
  }),
  z.strictObject({
    ...ForecastAssumptionShape,
    kind: z.literal("timing_shift"),
    targetRef: RecordRefSchema.extend({ revision: RevisionSchema }),
    shiftDays: z.union([
      z.number().int().safe().max(-1),
      z.number().int().safe().min(1),
    ]),
  }),
]);

const ForecastComponentShape = { inputRefs: z.array(RecordRefSchema) };

export const ForecastComponentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...ForecastComponentShape, kind: z.literal("actual_spend"), amount: NonNegativeMoneySchema }),
  z.strictObject({ ...ForecastComponentShape, kind: z.literal("outstanding_commitment"), amount: NonNegativeMoneySchema }),
  z.strictObject({ ...ForecastComponentShape, kind: z.literal("uncommitted_baseline"), amount: NonNegativeMoneySchema }),
  z.strictObject({ ...ForecastComponentShape, kind: z.literal("scenario_adjustment"), amount: SignedMoneySchema }),
]);

export const ForecastSnapshotSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  forecastId: IdSchema,
  revision: RevisionSchema,
  kind: z.enum(["baseline", "scenario"]),
  scope: ScopeRefSchema,
  asOfCutoff: TimestampSchema,
  horizonEnd: TimestampSchema,
  calculationVersion: z.string().min(1),
  inputVersions: z.array(RecordRefSchema),
  sourceWatermarks: z.record(z.string(), z.string()),
  assumptions: z.array(ForecastAssumptionSchema),
  components: z.array(ForecastComponentSchema).min(1),
  total: NonNegativeMoneySchema,
  sensitivity: z.strictObject({
    low: NonNegativeMoneySchema,
    base: NonNegativeMoneySchema,
    high: NonNegativeMoneySchema,
    calibratedProbability: z.literal(false),
  }),
  coverageWarnings: z.array(z.string()),
  correctsForecastRef: RecordRefSchema.optional(),
  completedAt: TimestampSchema,
});

export const JobStateSchema = z.enum([
  "pending", "running", "completed", "waiting_for_approval", "waiting_for_retry", "failed", "canceled",
]);

export const DurableJobMessageSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  jobId: IdSchema,
  revision: RevisionSchema,
  jobType: z.enum(["request_investigation", "source_ingestion", "reconciliation", "forecast_refresh", "scenario", "summary_rebuild"]),
  originPrincipalId: IdSchema,
  serviceIdentityId: IdSchema,
  scope: ScopeRefSchema,
  priority: PrioritySchema,
  state: JobStateSchema,
  inputVersions: z.array(RecordRefSchema),
  deduplicationKey: z.string().min(1),
  currentStep: z.string().min(1),
  checkpointRefs: z.array(RecordRefSchema),
  attempts: z.number().int().nonnegative(),
  eligibleAt: TimestampSchema,
  deadlineAt: TimestampSchema.nullable(),
  lease: z.strictObject({ ownerId: IdSchema, generation: RevisionSchema, expiresAt: TimestampSchema }).nullable(),
});

export type ForecastSnapshot = z.infer<typeof ForecastSnapshotSchema>;
export type DurableJobMessage = z.infer<typeof DurableJobMessageSchema>;
