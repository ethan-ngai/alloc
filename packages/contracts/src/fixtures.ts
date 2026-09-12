import { CONTRACT_SCHEMA_VERSION } from "./common.js";
import { ApprovalGrantSchema, ActionIntentSchema, ActionReceiptSchema, CommitmentSchema, DecisionSchema, PostingSchema, PurchaseRequestRevisionSchema, RequestAmendmentSchema } from "./financial.js";

const at = (minute: number) => `2026-09-12T14:${String(minute).padStart(2, "0")}:00Z`;
const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" as const });
const orgId = "org_northstar";
const requestId = "request_buffalo_trip";
const policyRef = { type: "policy", id: "policy_travel", revision: 1 };
const requestRef = (revision: number) => ({ type: "request", id: requestId, revision });
const provenance = (sourceObjectId: string, minute: number, trust: "authoritative" | "evidence" = "authoritative") => ({
  kind: "synthetic" as const,
  trust,
  sourceInstanceId: "source_northstar_simulator",
  sourceObjectId,
  sourceRevision: "1",
  occurredAt: at(minute),
  observedAt: at(minute),
});
const scopes = [
  { type: "organization" as const, id: orgId },
  { type: "department" as const, id: "department_field_engineering" },
  { type: "project" as const, id: "project_beacon" },
];

export const NORTHSTAR_SCENARIO_ID = "scenario_northstar_amendment_v1";

export const northstarScenario = Object.freeze({
  scenarioId: NORTHSTAR_SCENARIO_ID,
  seed: "northstar-contracts-2026-09-12-v1",
  organizationId: orgId,
  requestRevisions: [
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, requestId, revision: 1, previousRevision: null,
      requesterId: "employee_maya_chen", purpose: "Buffalo Beacon pilot trip", fullAmount: usd(18_000),
      increaseFromPrevious: usd(0), cumulativeIncrease: usd(0), categoryId: "category_travel",
      vendorId: "vendor_buffalo_hotel", projectId: "project_beacon", scopes, evaluationState: "approved",
      submittedAt: at(0), provenance: provenance("buffalo-trip-request", 0),
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, requestId, revision: 2, previousRevision: 1,
      requesterId: "employee_maya_chen", purpose: "Buffalo Beacon pilot trip", fullAmount: usd(21_000),
      increaseFromPrevious: usd(3_000), cumulativeIncrease: usd(3_000), categoryId: "category_travel",
      vendorId: "vendor_buffalo_hotel", projectId: "project_beacon", scopes, evaluationState: "approved",
      submittedAt: at(5), provenance: provenance("buffalo-trip-amendment-1", 5),
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, requestId, revision: 3, previousRevision: 2,
      requesterId: "employee_maya_chen", purpose: "Buffalo Beacon pilot trip", fullAmount: usd(24_000),
      increaseFromPrevious: usd(3_000), cumulativeIncrease: usd(6_000), categoryId: "category_travel",
      vendorId: "vendor_buffalo_hotel", projectId: "project_beacon", scopes, evaluationState: "review_required",
      submittedAt: at(10), provenance: provenance("buffalo-trip-amendment-2", 10),
    },
  ],
  amendments: [
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, amendmentId: "amendment_buffalo_trip_1", requestId,
      fromRevision: 1, toRevision: 2, previousFullAmount: usd(18_000), revisedFullAmount: usd(21_000), increase: usd(3_000),
      cumulativeIncrease: usd(3_000), reason: "Additional pilot-day lodging", submittedBy: "employee_maya_chen",
      submittedAt: at(5), provenance: provenance("buffalo-trip-amendment-1", 5),
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, amendmentId: "amendment_buffalo_trip_2", requestId,
      fromRevision: 2, toRevision: 3, previousFullAmount: usd(21_000), revisedFullAmount: usd(24_000), increase: usd(3_000),
      cumulativeIncrease: usd(6_000), reason: "Revised ground transportation", submittedBy: "employee_maya_chen",
      submittedAt: at(10), provenance: provenance("buffalo-trip-amendment-2", 10),
    },
  ],
  reviewDecision: {
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, decisionId: "decision_review_required", requestRef: requestRef(3),
    outcome: "review_required", reasonCodes: ["CUMULATIVE_INCREASE_LIMIT_EXCEEDED"], policyRef, authorizationEpoch: 1,
    evaluatedFullAmount: usd(24_000), evaluatedCumulativeIncrease: usd(6_000), factualInputs: [requestRef(3), policyRef],
    evidenceRefs: [{ type: "evidence", id: "evidence_trip_active", revision: 1 }], requiredApproverRole: "finance_manager",
    permittedAction: null, decidedAt: at(11),
  },
  approvalGrant: {
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, grantId: "grant_finance_review", requestRef: requestRef(3),
    approverId: "employee_avery_finance", authorityRole: "finance_manager", actionType: "approve_amendment",
    exactAmount: usd(24_000), policyRef, authorizationEpoch: 1, scope: { type: "department", id: "department_field_engineering" },
    grantedAt: at(15), expiresAt: at(45),
  },
  approvedDecision: {
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, decisionId: "decision_human_approval", requestRef: requestRef(3),
    outcome: "approved", reasonCodes: ["AUTHORIZED_HUMAN_EXCEPTION"], policyRef, authorizationEpoch: 1,
    evaluatedFullAmount: usd(24_000), evaluatedCumulativeIncrease: usd(6_000), factualInputs: [requestRef(3), policyRef],
    evidenceRefs: [{ type: "evidence", id: "evidence_trip_active", revision: 1 }], requiredApproverRole: null,
    approvalGrantRef: { type: "approval_grant", id: "grant_finance_review", revision: 1 },
    permittedAction: { type: "simulate_purchase", amount: usd(24_000) }, decidedAt: at(16),
  },
  commitment: {
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, commitmentId: "commitment_buffalo_trip", revision: 1,
    requestRef: requestRef(3), decisionRef: { type: "decision", id: "decision_human_approval", revision: 1 },
    amount: usd(24_000), outstandingAmount: usd(0), state: "posted",
    budgetAccountRefs: [{ type: "budget_account", id: "budget_field_travel", revision: 4 }], createdAt: at(16),
  },
  actionIntent: {
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, actionIntentId: "action_buffalo_purchase", revision: 1,
    requestRef: requestRef(3), decisionRef: { type: "decision", id: "decision_human_approval", revision: 1 },
    commandId: "command_dispatch_buffalo", providerInstanceId: "provider_simulated_spend", idempotencyKey: "northstar-buffalo-v3",
    action: { type: "simulate_purchase", amount: usd(24_000), vendorId: "vendor_buffalo_hotel" }, state: "succeeded", createdAt: at(16),
  },
  actionReceipt: {
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, receiptId: "receipt_buffalo_purchase",
    actionIntentRef: { type: "action_intent", id: "action_buffalo_purchase", revision: 1 }, providerInstanceId: "provider_simulated_spend",
    providerOperationId: "sim-op-northstar-buffalo-v3", outcome: "succeeded", amount: usd(24_000), observedAt: at(20),
  },
  posting: {
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, postingId: "posting_buffalo_hotel", revision: 1,
    amount: usd(24_000), occurredAt: at(25), status: "posted",
    commitmentRef: { type: "commitment", id: "commitment_buffalo_trip", revision: 1 },
    sourceRef: { type: "action_receipt", id: "receipt_buffalo_purchase", revision: 1 }, scopes,
    provenance: provenance("sim-op-northstar-buffalo-v3", 25),
  },
  expectedTotals: { approvedAmount: usd(24_000), cumulativeIncrease: usd(6_000), outstandingCommitments: usd(0), recognizedSpend: usd(24_000), commitmentToSpend: usd(24_000) },
});

export const contractExamples = Object.freeze({
  memory: {
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, queryId: "query_beacon_trip", asOf: at(26),
    facts: [{ ref: requestRef(3), label: "Approved trip amount", value: usd(24_000), scopeRefs: scopes, provenance: provenance("buffalo-trip-amendment-2", 10) }],
    evidence: [], assumptions: [], missingFields: [], sourceWatermarks: { simulator: "delivery-26" }, page: { nextCursor: null, truncated: false },
  },
  forecast: {
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: orgId, forecastId: "forecast_beacon_q3", revision: 1, kind: "baseline",
    scope: { type: "project", id: "project_beacon" }, asOfCutoff: at(30), horizonEnd: "2026-09-30T23:59:59Z",
    calculationVersion: "operational-spend-v1", inputVersions: [{ type: "posting", id: "posting_buffalo_hotel", revision: 1 }],
    sourceWatermarks: { simulator: "delivery-30" }, assumptions: [],
    components: [{ kind: "actual_spend", amount: usd(24_000), inputRefs: [{ type: "posting", id: "posting_buffalo_hotel", revision: 1 }] }],
    total: usd(24_000), sensitivity: { low: usd(24_000), base: usd(24_000), high: usd(24_000), calibratedProbability: false },
    coverageWarnings: [], completedAt: at(31),
  },
  event: {
    schemaVersion: CONTRACT_SCHEMA_VERSION, eventId: "event_posting_recorded", organizationId: orgId,
    eventType: "posting.recorded", aggregateRef: { type: "posting", id: "posting_buffalo_hotel", revision: 1 }, aggregateRevision: 1,
    correlationId: "correlation_buffalo_trip", causationId: "command_record_posting", occurredAt: at(25), payload: northstarScenario.posting,
  },
  toolInput: { requestId },
  errors: {
    staleVersion: { schemaVersion: CONTRACT_SCHEMA_VERSION, code: "STALE_VERSION", message: "Request revision is no longer current", retryable: false, correlationId: "correlation_stale", details: { expected: 2, actual: 3 } },
    deniedAuthority: { schemaVersion: CONTRACT_SCHEMA_VERSION, code: "AUTHORITY_DENIED", message: "Approver lacks authority for this scope", retryable: false, correlationId: "correlation_denied" },
    idempotencyConflict: { schemaVersion: CONTRACT_SCHEMA_VERSION, code: "IDEMPOTENCY_CONFLICT", message: "Command ID was reused with a different payload", retryable: false, correlationId: "correlation_idempotency" },
    unknownOutcome: { schemaVersion: CONTRACT_SCHEMA_VERSION, code: "OUTCOME_UNKNOWN", message: "Provider outcome requires reconciliation", retryable: false, correlationId: "correlation_unknown" },
  },
});

export function validateNorthstarScenario(candidate: typeof northstarScenario): void {
  const requests = candidate.requestRevisions.map((request) => PurchaseRequestRevisionSchema.parse(request));
  const amendments = candidate.amendments.map((amendment) => RequestAmendmentSchema.parse(amendment));
  const review = DecisionSchema.parse(candidate.reviewDecision);
  const approval = DecisionSchema.parse(candidate.approvedDecision);
  const grant = ApprovalGrantSchema.parse(candidate.approvalGrant);
  const commitment = CommitmentSchema.parse(candidate.commitment);
  const intent = ActionIntentSchema.parse(candidate.actionIntent);
  const receipt = ActionReceiptSchema.parse(candidate.actionReceipt);
  const posting = PostingSchema.parse(candidate.posting);
  const latest = requests.at(-1);
  if (!latest || latest.revision !== 3 || latest.previousRevision !== 2) throw new Error("request revision chain is invalid");
  if (amendments[0]?.fromRevision !== 1 || amendments[0].toRevision !== 2 || amendments[1]?.fromRevision !== 2 || amendments[1].toRevision !== 3) throw new Error("amendment revision chain is invalid");
  if (review.requestRef.id !== latest.requestId || review.requestRef.revision !== latest.revision) throw new Error("review does not reference the latest request");
  if (grant.requestRef.id !== latest.requestId || grant.requestRef.revision !== latest.revision) throw new Error("grant does not bind the reviewed request revision");
  if (approval.approvalGrantRef?.id !== grant.grantId) throw new Error("approval does not reference the grant");
  if (commitment.decisionRef.id !== approval.decisionId) throw new Error("commitment does not reference the approval decision");
  if (intent.requestRef.id !== latest.requestId || intent.decisionRef.id !== approval.decisionId) throw new Error("action intent references are invalid");
  if (receipt.actionIntentRef.id !== intent.actionIntentId) throw new Error("receipt does not reference the action intent");
  if (posting.commitmentRef?.id !== commitment.commitmentId || posting.sourceRef.id !== receipt.receiptId) throw new Error("posting reconciliation references are invalid");
  const recognized = posting.amount.amountMinor;
  const outstanding = commitment.outstandingAmount.amountMinor;
  if (recognized + outstanding !== candidate.expectedTotals.commitmentToSpend.amountMinor) throw new Error("commitment-to-spend total is inconsistent");
}
