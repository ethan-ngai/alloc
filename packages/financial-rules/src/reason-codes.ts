import type { BudgetAccount, Policy, PurchaseRequestRevision, RecordRef } from "@alloc/contracts";

/**
 * Stable reason-code vocabulary. The automatic-approval, cumulative-limit, and human-exception
 * codes reuse the frozen 1A/2A fixture and 2C mock vocabulary so every consumer renders the
 * same states.
 */
export const REASON_CODE = {
  WITHIN_CUMULATIVE_ALLOWANCE: "WITHIN_CUMULATIVE_ALLOWANCE",
  AUTHORIZED_HUMAN_EXCEPTION: "AUTHORIZED_HUMAN_EXCEPTION",
  CUMULATIVE_INCREASE_LIMIT_EXCEEDED: "CUMULATIVE_INCREASE_LIMIT_EXCEEDED",
  FULL_AMOUNT_EXCEEDS_AUTO_LIMIT: "FULL_AMOUNT_EXCEEDS_AUTO_LIMIT",
  POLICY_COVERAGE_MISSING: "POLICY_COVERAGE_MISSING",
  REQUESTER_ROLE_NOT_ELIGIBLE: "REQUESTER_ROLE_NOT_ELIGIBLE",
  POLICY_REQUIRES_REVIEW: "POLICY_REQUIRES_REVIEW",
  POLICY_NOT_YET_EFFECTIVE: "POLICY_NOT_YET_EFFECTIVE",
  POLICY_EXPIRED: "POLICY_EXPIRED",
  POLICY_SCOPE_MISMATCH: "POLICY_SCOPE_MISMATCH",
  MISSING_TRUSTED_FACTS: "MISSING_TRUSTED_FACTS",
  EVIDENCE_MISSING: "EVIDENCE_MISSING",
  EVIDENCE_STALE: "EVIDENCE_STALE",
  PURPOSE_NOT_ACTIVE: "PURPOSE_NOT_ACTIVE",
  VENDOR_NOT_ELIGIBLE: "VENDOR_NOT_ELIGIBLE",
  SOFT_CAP_CAPACITY_INSUFFICIENT: "SOFT_CAP_CAPACITY_INSUFFICIENT",
  EXPLICIT_DENY_RULE: "EXPLICIT_DENY_RULE",
  HARD_CAP_CAPACITY_INSUFFICIENT: "HARD_CAP_CAPACITY_INSUFFICIENT",
  GRANT_ORGANIZATION_MISMATCH: "GRANT_ORGANIZATION_MISMATCH",
  GRANT_REQUEST_MISMATCH: "GRANT_REQUEST_MISMATCH",
  GRANT_REVISION_MISMATCH: "GRANT_REVISION_MISMATCH",
  GRANT_AMOUNT_MISMATCH: "GRANT_AMOUNT_MISMATCH",
  GRANT_ACTION_MISMATCH: "GRANT_ACTION_MISMATCH",
  GRANT_POLICY_MISMATCH: "GRANT_POLICY_MISMATCH",
  GRANT_EPOCH_MISMATCH: "GRANT_EPOCH_MISMATCH",
  GRANT_NOT_YET_EFFECTIVE: "GRANT_NOT_YET_EFFECTIVE",
  GRANT_EXPIRED: "GRANT_EXPIRED",
  GRANT_AUTHORITY_REVOKED: "GRANT_AUTHORITY_REVOKED",
  GRANT_APPROVER_IDENTITY_MISMATCH: "GRANT_APPROVER_IDENTITY_MISMATCH",
  GRANT_APPROVER_ROLE_MISMATCH: "GRANT_APPROVER_ROLE_MISMATCH",
  GRANT_APPROVER_SCOPE_MISMATCH: "GRANT_APPROVER_SCOPE_MISMATCH",
  GRANT_SCOPE_MISMATCH: "GRANT_SCOPE_MISMATCH",
  GRANT_SELF_APPROVAL_PROHIBITED: "GRANT_SELF_APPROVAL_PROHIBITED",
  GRANT_HARD_CAP_EXHAUSTED: "GRANT_HARD_CAP_EXHAUSTED",
} as const;

export type ReasonCode = (typeof REASON_CODE)[keyof typeof REASON_CODE];

export function sortedUniqueReasonCodes(codes: readonly ReasonCode[]): ReasonCode[] {
  return [...new Set(codes)].sort();
}

export function refOfRequest(request: PurchaseRequestRevision): RecordRef {
  return { type: "request", id: request.requestId, revision: request.revision };
}

export function refOfPolicy(policy: Policy): RecordRef {
  return { type: "policy", id: policy.policyId, revision: policy.revision };
}

export function refOfBudget(account: BudgetAccount): RecordRef {
  return { type: "budget_account", id: account.budgetAccountId, revision: account.revision };
}

export function refOfEvidence(value: { evidenceId: string; revision: number }): RecordRef {
  return { type: "evidence", id: value.evidenceId, revision: value.revision };
}

export function dedupeRefs(refs: readonly RecordRef[]): RecordRef[] {
  const seen = new Set<string>();
  const unique: RecordRef[] = [];
  for (const ref of refs) {
    const key = `${ref.type}\u0000${ref.id}\u0000${ref.revision ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}
