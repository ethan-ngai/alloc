import type { z } from "zod";
import type {
  ActivityItemSchema, BudgetAccountSchema, CommandMetaSchema, DurableJobMessageSchema, EvidenceSchema,
  ForecastAssumptionSchema, MemoryFactSchema, NonNegativeMoneySchema, PageInfoSchema, PolicySchema,
  PositiveMoneySchema, ProvenanceSchema, QueryMetaSchema, RecordRefSchema, ScopeRefSchema,
  SourceDeliverySchema, VersionExpectationSchema,
} from "@alloc/contracts";
import type { ForecastSnapshotSchema, PostingCorrectionSchema } from "@alloc/contracts";

/**
 * The contracts package exports inferred types for its frozen fixtures but not for several
 * structural schemas, so the mock derives them here instead of narrowing or forking the package.
 */
export type ScopeRef = z.infer<typeof ScopeRefSchema>;
export type RecordRef = z.infer<typeof RecordRefSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type ActivityItem = z.infer<typeof ActivityItemSchema>;
export type MemoryFact = z.infer<typeof MemoryFactSchema>;
export type PageInfo = z.infer<typeof PageInfoSchema>;
export type VersionExpectation = z.infer<typeof VersionExpectationSchema>;
export type CommandMeta = z.infer<typeof CommandMetaSchema>;
export type QueryMeta = z.infer<typeof QueryMetaSchema>;
export type BudgetAccount = z.infer<typeof BudgetAccountSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type PositiveMoney = z.infer<typeof PositiveMoneySchema>;
export type NonNegativeMoney = z.infer<typeof NonNegativeMoneySchema>;
export type SourceDelivery = z.infer<typeof SourceDeliverySchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type ForecastAssumption = z.infer<typeof ForecastAssumptionSchema>;
export type DurableJobMessage = z.infer<typeof DurableJobMessageSchema>;
export type PostingCorrection = z.infer<typeof PostingCorrectionSchema>;
export type ForecastSnapshot = z.infer<typeof ForecastSnapshotSchema>;
