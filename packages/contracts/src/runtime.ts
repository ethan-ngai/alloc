import { z } from "zod";
import {
  ContractSchemaVersionSchema, IdSchema, NonNegativeMoneySchema, OrganizationIdSchema,
  PrioritySchema, RecordRefSchema, RevisionSchema, ScopeRefSchema, TimestampSchema,
} from "./common.js";

export const ForecastAssumptionSchema = z.strictObject({
  assumptionId: IdSchema,
  name: z.string().min(1),
  kind: z.enum(["fixed_adjustment", "percentage_change", "timing_shift"]),
  valueBasisPoints: z.number().int().min(-10_000).max(100_000).optional(),
  amount: NonNegativeMoneySchema.optional(),
  scope: ScopeRefSchema,
  effectiveFrom: TimestampSchema,
  effectiveTo: TimestampSchema,
  evidenceRefs: z.array(RecordRefSchema),
});

export const ForecastComponentSchema = z.strictObject({
  kind: z.enum(["actual_spend", "outstanding_commitment", "uncommitted_baseline", "scenario_adjustment"]),
  amount: NonNegativeMoneySchema,
  inputRefs: z.array(RecordRefSchema),
});

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
