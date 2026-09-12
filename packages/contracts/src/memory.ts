import { z } from "zod";
import {
  AccessScopeSchema, ContractSchemaVersionSchema, DateSchema, IdSchema, NonNegativeMoneySchema,
  OrganizationIdSchema, PageInfoSchema, ProvenanceSchema, RecordRefSchema, RevisionSchema,
  ScopeRefSchema, SignedMoneySchema, TimestampSchema,
} from "./common.js";

export const EntityKindSchema = z.enum([
  "organization", "department", "project", "category", "location", "vendor", "employee",
  "customer", "asset", "contract", "legal_entity", "financial_account", "inventory_item",
  "receivable", "payable", "liability", "tax_obligation", "insurance_policy",
]);

export const CompanyEntitySchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  entityId: IdSchema,
  revision: RevisionSchema,
  kind: EntityKindSchema,
  displayName: z.string().min(1),
  projectId: IdSchema.optional(),
  access: AccessScopeSchema,
  provenance: ProvenanceSchema,
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export const SourceDeliverySchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  sourceInstanceId: IdSchema,
  deliveryId: z.string().min(1),
  sourceObjectId: z.string().min(1),
  sourceRevision: z.string().min(1),
  eventType: z.string().min(1),
  occurredAt: TimestampSchema,
  observedAt: TimestampSchema,
  isSynthetic: z.boolean(),
  provenance: ProvenanceSchema,
  payload: z.record(z.string(), z.unknown()),
});

export const EvidenceSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  evidenceId: IdSchema,
  revision: RevisionSchema,
  kind: z.enum(["source_record", "document_excerpt", "metric", "decision_precedent"]),
  title: z.string().min(1),
  content: z.string().min(1),
  access: AccessScopeSchema,
  provenance: ProvenanceSchema,
  authoritativeFor: z.array(z.string().min(1)),
});

export const RelationshipSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  relationshipId: IdSchema,
  revision: RevisionSchema,
  fromId: IdSchema,
  toId: IdSchema,
  type: z.enum([
    "assigned_to", "owned_by", "implemented_by", "funded_by", "has_trip", "uses_vendor",
    "located_at", "allocated_to", "obligated_to", "supplied_by", "billed_to",
  ]),
  verification: z.enum(["verified", "candidate", "rejected"]),
  validFrom: TimestampSchema,
  validTo: TimestampSchema.nullable(),
  evidenceRefs: z.array(RecordRefSchema).min(1),
  allocationBasisPoints: z.number().int().min(0).max(10_000).optional(),
  access: AccessScopeSchema,
});

/** A bounded, access-filtered graph view. `evidenceRefs` are the drill-down path. */
export const GraphContextSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  subjectRef: RecordRefSchema.omit({ revision: true }),
  entities: z.array(CompanyEntitySchema),
  relationships: z.array(RelationshipSchema),
  evidenceRefs: z.array(RecordRefSchema),
  summary: z.string().min(1),
  sourceWatermark: z.string().min(1),
  truncated: z.boolean(),
});

export const FinancialDomainSchema = z.enum([
  "food_expense", "facilities", "physical_assets", "software_cloud_ai", "labor",
  "procurement_inventory", "cash", "liabilities", "revenue_receivables", "taxes_insurance", "governance",
]);

export const FinancialScheduleSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  scheduleId: IdSchema,
  revision: RevisionSchema,
  domain: FinancialDomainSchema,
  obligationId: IdSchema,
  scopeRefs: z.array(ScopeRefSchema).min(1),
  cadence: z.enum(["once", "weekly", "monthly", "quarterly", "annual"]),
  amount: NonNegativeMoneySchema,
  startsOn: DateSchema,
  endsOn: DateSchema.nullable(),
  nextDueOn: DateSchema,
  status: z.enum(["active", "paused", "completed", "canceled"]),
  provenance: ProvenanceSchema,
});

export const MemoryFactSchema = z.strictObject({
  ref: RecordRefSchema,
  label: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), NonNegativeMoneySchema, SignedMoneySchema]),
  scopeRefs: z.array(ScopeRefSchema),
  provenance: ProvenanceSchema,
});

export const MemoryResponseSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  queryId: IdSchema,
  asOf: TimestampSchema,
  facts: z.array(MemoryFactSchema),
  evidence: z.array(EvidenceSchema),
  assumptions: z.array(z.string()),
  missingFields: z.array(z.string()),
  sourceWatermarks: z.record(z.string(), z.string()),
  page: PageInfoSchema,
});

export type CompanyEntity = z.infer<typeof CompanyEntitySchema>;
export type SourceDelivery = z.infer<typeof SourceDeliverySchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Relationship = z.infer<typeof RelationshipSchema>;
export type GraphContext = z.infer<typeof GraphContextSchema>;
export type MemoryResponse = z.infer<typeof MemoryResponseSchema>;
