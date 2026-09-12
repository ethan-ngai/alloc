import { CONTRACT_SCHEMA_VERSION } from "@alloc/contracts";
import type { ApprovalGrant, BudgetAccount, Evidence, Policy, PolicyRule, Provenance, PurchaseRequestRevision, ScopeRef } from "@alloc/contracts";
import { subtractUsd, usd } from "../src/index.js";
import type { ApproverAuthority, CumulativeTotalInput, PolicyEvaluationInput, TrustedPurposeState } from "../src/index.js";
import { FinancialRulesInputError } from "../src/index.js";

/** Every contract key optional and removable, so table cases can drop optional facts. */
export type Mutable<T> = { [K in keyof T]?: T[K] | undefined };

export const ORGANIZATION_ID = "org_northstar";
export const EVALUATED_AT = "2026-09-12T14:00:00Z";
export const PURPOSE = "Buffalo Beacon pilot trip";
export const REQUEST_ID = "request_buffalo_trip";
export const REQUESTER_ID = "employee_maya_chen";
export const APPROVER_ID = "employee_avery_finance";
export const EVIDENCE_ID = "evidence_trip_active";
export const EVIDENCE_OBSERVED_AT = "2026-06-14T00:00:00Z";

export const organizationScope: ScopeRef = { type: "organization", id: ORGANIZATION_ID };
export const departmentScope: ScopeRef = { type: "department", id: "department_field_engineering" };
export const projectScope: ScopeRef = { type: "project", id: "project_beacon" };

export const requestReference = (revision: number) => ({ type: "request", id: REQUEST_ID, revision });

export function clean<T>(value: T): T {
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return value;
}

const provenance = (sourceObjectId: string, at = EVALUATED_AT): Provenance => ({
  kind: "synthetic", trust: "authoritative", sourceInstanceId: "source_northstar_simulator",
  sourceObjectId, sourceRevision: "1", occurredAt: at, observedAt: at,
});

/** Provenance matching the frozen 1A Northstar fixture records. */
export const authoritativeProvenance = provenance;

/** Runs a call that must fail and returns the explicit invalid-input code. */
export function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof FinancialRulesInputError) return error.code;
    throw error;
  }
  throw new Error("expected the call to throw a FinancialRulesInputError");
}

/** Runs a call that must fail and returns the message, which names the code and the failing path. */
export function errorMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof FinancialRulesInputError) return error.message;
    throw error;
  }
  throw new Error("expected the call to throw a FinancialRulesInputError");
}

/** Revision 2 of the Northstar trip: $210 total, $30 cumulative increase, inside every limit. */
export function request(overrides: Mutable<PurchaseRequestRevision> = {}): PurchaseRequestRevision {
  return clean({
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: ORGANIZATION_ID, requestId: REQUEST_ID, revision: 2, previousRevision: 1,
    requesterId: REQUESTER_ID, purpose: PURPOSE, fullAmount: usd(21_000), increaseFromPrevious: usd(3_000), cumulativeIncrease: usd(3_000),
    categoryId: "category_travel", vendorId: "vendor_buffalo_hotel", projectId: "project_beacon",
    scopes: [organizationScope, departmentScope, projectScope], evaluationState: "submitted", submittedAt: EVALUATED_AT,
    provenance: provenance("buffalo-trip-amendment-1"),
    ...overrides,
  }) as PurchaseRequestRevision;
}

export function rule(overrides: Mutable<PolicyRule> = {}): PolicyRule {
  return clean({
    ruleId: "rule_small_purchase", effect: "permit", categoryIds: ["category_travel"], requesterRoles: ["employee"],
    maximumFullAmount: usd(25_000), maximumCumulativeIncrease: usd(5_000), requireActivePurpose: true,
    requiredEvidenceKinds: ["document_excerpt"], eligibleVendorIds: ["vendor_buffalo_hotel"],
    maximumEvidenceAgeSeconds: 15_552_000, requiredApproverRole: "finance_manager",
    prohibitRequesterApproval: true, cumulativeLimitScope: "purpose",
    ...overrides,
  }) as PolicyRule;
}

export function policy(overrides: Mutable<Policy> & { rules?: PolicyRule[] } = {}): Policy {
  return clean({
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: ORGANIZATION_ID, policyId: "policy_travel", revision: 1,
    authorizationEpoch: 1, name: "Synthetic small-purchase cumulative allowance", scope: organizationScope,
    effectiveFrom: "2026-06-14T00:00:00Z", effectiveTo: null, rules: [rule()], publishedBy: APPROVER_ID,
    ...overrides,
  }) as Policy;
}

export function budget(overrides: Mutable<BudgetAccount> = {}): BudgetAccount {
  const authorized = overrides.authorized ?? usd(958_060);
  const recognizedSpend = overrides.recognizedSpend ?? usd(882_060);
  const outstandingCommitments = overrides.outstandingCommitments ?? usd(0);
  return clean({
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: ORGANIZATION_ID, budgetAccountId: "budget_field_travel",
    revision: 4, scope: organizationScope, authorized, recognizedSpend, outstandingCommitments,
    available: subtractUsd(subtractUsd(authorized, recognizedSpend), outstandingCommitments),
    hardCap: true, periodStart: "2026-06-14", periodEnd: "2026-09-30",
    ...overrides,
  }) as BudgetAccount;
}

export function evidence(overrides: Mutable<Evidence> = {}): Evidence {
  return clean({
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: ORGANIZATION_ID, evidenceId: EVIDENCE_ID, revision: 1,
    kind: "document_excerpt", title: "Synthetic active purpose brief", content: `${PURPOSE}. Synthetic trip brief.`,
    access: { classification: "internal", scopeRefs: [organizationScope], allowedPrincipalIds: [] },
    provenance: { kind: "synthetic", trust: "evidence", sourceInstanceId: "source_northstar_simulator", sourceObjectId: "purpose-brief", sourceRevision: "1", occurredAt: EVIDENCE_OBSERVED_AT, observedAt: EVIDENCE_OBSERVED_AT },
    authoritativeFor: [],
    ...overrides,
  }) as Evidence;
}

export function cumulativeTotal(overrides: Mutable<CumulativeTotalInput> = {}): CumulativeTotalInput {
  return clean({
    dimension: "purpose", dimensionId: PURPOSE, cumulativeIncrease: usd(3_000), sources: [requestReference(2)],
    ...overrides,
  }) as CumulativeTotalInput;
}

export function purposeState(overrides: Mutable<TrustedPurposeState> = {}): TrustedPurposeState {
  return clean({ purpose: PURPOSE, active: true, ref: { type: "evidence", id: EVIDENCE_ID, revision: 1 }, ...overrides }) as TrustedPurposeState;
}

/** Revision 3 of the Northstar trip: $240 total and $60 cumulative increase, over the $50 allowance. */
export const reviewRequest = request({ revision: 3, previousRevision: 2, fullAmount: usd(24_000), cumulativeIncrease: usd(6_000), provenance: provenance("buffalo-trip-amendment-2") });
export const reviewTotals: CumulativeTotalInput[] = [cumulativeTotal({ cumulativeIncrease: usd(6_000), sources: [requestReference(3)] })];

export function evaluationInput(overrides: Mutable<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return clean({
    evaluatedAt: EVALUATED_AT,
    request: request(),
    policy: policy(),
    requesterRoles: ["employee"],
    purpose: purposeState(),
    cumulativeTotals: [cumulativeTotal()],
    evidence: [evidence()],
    budgets: [{ account: budget(), reserveDelta: usd(3_000) }],
    ...overrides,
  }) as PolicyEvaluationInput;
}

export function approvalGrant(overrides: Mutable<ApprovalGrant> = {}): ApprovalGrant {
  return clean({
    schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: ORGANIZATION_ID, grantId: "grant_finance_review",
    requestRef: requestReference(2), approverId: APPROVER_ID, authorityRole: "finance_manager",
    actionType: "approve_amendment", exactAmount: usd(21_000), policyRef: { type: "policy", id: "policy_travel", revision: 1 },
    authorizationEpoch: 1, scope: departmentScope, grantedAt: "2026-09-12T14:15:00Z", expiresAt: "2026-09-12T14:45:00Z",
    ...overrides,
  }) as ApprovalGrant;
}

export function approverAuthority(overrides: Mutable<ApproverAuthority> = {}): ApproverAuthority {
  return clean({
    organizationId: ORGANIZATION_ID, approverId: APPROVER_ID, roles: ["finance_manager"], scopes: [organizationScope],
    ...overrides,
  }) as ApproverAuthority;
}
