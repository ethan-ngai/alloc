import { z } from "zod";
import {
  AccessScopeSchema, ContractSchemaVersionSchema, DateSchema, IdSchema,
  NonNegativeMoneySchema, OrganizationIdSchema, PositiveMoneySchema, ProvenanceSchema,
  RecordRefSchema, RevisionSchema, ScopeRefSchema, SignedMoneySchema, SignedNonZeroMoneySchema, TimestampSchema,
} from "./common.js";

export const RequestEvaluationStateSchema = z.enum(["submitted", "evaluating", "approved", "review_required", "denied"]);
export const HumanReviewStateSchema = z.enum(["review_required", "approved", "denied", "expired"]);
export const ActionStateSchema = z.enum(["pending", "dispatching", "succeeded", "failed", "outcome_unknown", "canceled"]);
/**
 * Dimension a cumulative increase allowance is measured over. Omitted on a rule means "purpose",
 * which measures the evaluating request's own revision chain.
 */
export const CumulativeLimitScopeSchema = z.enum(["employee", "purpose", "project"]);

export const PurchaseRequestRevisionSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  requestId: IdSchema,
  revision: RevisionSchema,
  previousRevision: RevisionSchema.nullable(),
  requesterId: IdSchema,
  purpose: z.string().min(1),
  fullAmount: PositiveMoneySchema,
  increaseFromPrevious: NonNegativeMoneySchema,
  cumulativeIncrease: NonNegativeMoneySchema,
  categoryId: IdSchema,
  vendorId: IdSchema.optional(),
  projectId: IdSchema.optional(),
  scopes: z.array(ScopeRefSchema).min(1),
  evaluationState: RequestEvaluationStateSchema,
  submittedAt: TimestampSchema,
  provenance: ProvenanceSchema,
});

export const RequestAmendmentSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  amendmentId: IdSchema,
  requestId: IdSchema,
  fromRevision: RevisionSchema,
  toRevision: RevisionSchema,
  previousFullAmount: PositiveMoneySchema,
  revisedFullAmount: PositiveMoneySchema,
  increase: SignedMoneySchema,
  cumulativeIncrease: NonNegativeMoneySchema,
  reason: z.string().min(1),
  submittedBy: IdSchema,
  submittedAt: TimestampSchema,
  provenance: ProvenanceSchema,
});

export const PolicyRuleSchema = z.strictObject({
  ruleId: IdSchema,
  effect: z.enum(["permit", "deny", "require_review"]),
  categoryIds: z.array(IdSchema).min(1),
  requesterRoles: z.array(z.string().min(1)).min(1),
  maximumFullAmount: NonNegativeMoneySchema.optional(),
  maximumCumulativeIncrease: NonNegativeMoneySchema.optional(),
  requireActivePurpose: z.boolean(),
  requiredEvidenceKinds: z.array(z.string().min(1)),
  eligibleVendorIds: z.array(IdSchema).min(1).optional(),
  maximumEvidenceAgeSeconds: z.number().int().safe().nonnegative().optional(),
  requiredApproverRole: z.string().min(1).optional(),
  prohibitRequesterApproval: z.boolean().optional(),
  cumulativeLimitScope: CumulativeLimitScopeSchema.optional(),
});

export const PolicySchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  policyId: IdSchema,
  revision: RevisionSchema,
  authorizationEpoch: RevisionSchema,
  name: z.string().min(1),
  scope: ScopeRefSchema,
  effectiveFrom: TimestampSchema,
  effectiveTo: TimestampSchema.nullable(),
  rules: z.array(PolicyRuleSchema).min(1),
  publishedBy: IdSchema,
});

export const ApprovalGrantSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  grantId: IdSchema,
  requestRef: RecordRefSchema,
  approverId: IdSchema,
  authorityRole: z.string().min(1),
  actionType: z.enum(["approve_request", "approve_amendment", "cancel_commitment"]),
  exactAmount: PositiveMoneySchema,
  policyRef: RecordRefSchema,
  authorizationEpoch: RevisionSchema,
  scope: ScopeRefSchema,
  grantedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});

export const DecisionSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  decisionId: IdSchema,
  requestRef: RecordRefSchema,
  outcome: z.enum(["approved", "review_required", "denied"]),
  reasonCodes: z.array(z.string().min(1)).min(1),
  policyRef: RecordRefSchema,
  authorizationEpoch: RevisionSchema,
  evaluatedFullAmount: PositiveMoneySchema,
  evaluatedCumulativeIncrease: NonNegativeMoneySchema,
  factualInputs: z.array(RecordRefSchema),
  evidenceRefs: z.array(RecordRefSchema),
  requiredApproverRole: z.string().min(1).nullable(),
  approvalGrantRef: RecordRefSchema.optional(),
  permittedAction: z.strictObject({ type: z.literal("simulate_purchase"), amount: PositiveMoneySchema }).nullable(),
  decidedAt: TimestampSchema,
});

export const BudgetAccountSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  budgetAccountId: IdSchema,
  revision: RevisionSchema,
  scope: ScopeRefSchema,
  authorized: NonNegativeMoneySchema,
  recognizedSpend: NonNegativeMoneySchema,
  outstandingCommitments: NonNegativeMoneySchema,
  available: SignedMoneySchema,
  hardCap: z.boolean(),
  periodStart: DateSchema,
  periodEnd: DateSchema,
});

export const CommitmentSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  commitmentId: IdSchema,
  revision: RevisionSchema,
  requestRef: RecordRefSchema,
  decisionRef: RecordRefSchema,
  amount: PositiveMoneySchema,
  outstandingAmount: NonNegativeMoneySchema,
  state: z.enum(["outstanding", "partially_posted", "posted", "canceled"]),
  budgetAccountRefs: z.array(RecordRefSchema).min(1),
  createdAt: TimestampSchema,
});

export const PostingSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  postingId: IdSchema,
  revision: RevisionSchema,
  amount: PositiveMoneySchema,
  occurredAt: TimestampSchema,
  status: z.enum(["posted", "refunded"]),
  obligationId: IdSchema.optional(),
  commitmentRef: RecordRefSchema.optional(),
  sourceRef: RecordRefSchema,
  scopes: z.array(ScopeRefSchema).min(1),
  provenance: ProvenanceSchema,
});

export const PostingCorrectionSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  correctionId: IdSchema,
  originalPostingRef: RecordRefSchema,
  amount: SignedNonZeroMoneySchema,
  reason: z.string().min(1),
  occurredAt: TimestampSchema,
  provenance: ProvenanceSchema,
});

export const ActionIntentSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  actionIntentId: IdSchema,
  revision: RevisionSchema,
  requestRef: RecordRefSchema,
  decisionRef: RecordRefSchema,
  commandId: IdSchema,
  providerInstanceId: IdSchema,
  idempotencyKey: z.string().min(1),
  action: z.strictObject({ type: z.literal("simulate_purchase"), amount: PositiveMoneySchema, vendorId: IdSchema }),
  state: ActionStateSchema,
  createdAt: TimestampSchema,
});

export const ActionReceiptSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  receiptId: IdSchema,
  actionIntentRef: RecordRefSchema,
  providerInstanceId: IdSchema,
  providerOperationId: z.string().min(1),
  outcome: z.enum(["succeeded", "failed", "outcome_unknown"]),
  amount: PositiveMoneySchema,
  observedAt: TimestampSchema,
  rawReceiptRef: RecordRefSchema.optional(),
});

export type PurchaseRequestRevision = z.infer<typeof PurchaseRequestRevisionSchema>;
export type RequestAmendment = z.infer<typeof RequestAmendmentSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type ApprovalGrant = z.infer<typeof ApprovalGrantSchema>;
export type BudgetAccount = z.infer<typeof BudgetAccountSchema>;
export type Commitment = z.infer<typeof CommitmentSchema>;
export type Posting = z.infer<typeof PostingSchema>;
export type ActionIntent = z.infer<typeof ActionIntentSchema>;
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;
