import type { z } from "zod";
import type {
  ActivityItemSchema, CommandMetaSchema, DurableJobMessageSchema, ForecastAssumptionSchema, ForecastSnapshotSchema,
  MemoryFactSchema, NonNegativeMoneySchema, PageInfoSchema, PositiveMoneySchema, PostingCorrectionSchema,
  QueryMetaSchema, VersionExpectationSchema,
} from "@alloc/contracts";

/**
 * `@alloc/contracts` 1.1.0 exports the reference, policy, budget, evidence, and source-delivery
 * types directly; this module re-exports them so mock consumers keep one import path, and derives
 * only the inferred types the contracts package still does not publish.
 */
export type { BudgetAccount, Evidence, Policy, Provenance, RecordRef, ScopeRef, SourceDelivery } from "@alloc/contracts";

export type ActivityItem = z.infer<typeof ActivityItemSchema>;
export type MemoryFact = z.infer<typeof MemoryFactSchema>;
export type PageInfo = z.infer<typeof PageInfoSchema>;
export type VersionExpectation = z.infer<typeof VersionExpectationSchema>;
export type CommandMeta = z.infer<typeof CommandMetaSchema>;
export type QueryMeta = z.infer<typeof QueryMetaSchema>;
export type PositiveMoney = z.infer<typeof PositiveMoneySchema>;
export type NonNegativeMoney = z.infer<typeof NonNegativeMoneySchema>;
export type ForecastAssumption = z.infer<typeof ForecastAssumptionSchema>;
export type DurableJobMessage = z.infer<typeof DurableJobMessageSchema>;
export type PostingCorrection = z.infer<typeof PostingCorrectionSchema>;
export type ForecastSnapshot = z.infer<typeof ForecastSnapshotSchema>;
