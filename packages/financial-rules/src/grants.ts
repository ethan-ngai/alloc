import type { PurchaseRequestRevision, ScopeRef } from "@alloc/contracts";
import { FinancialRulesInputError } from "./errors.js";
import { checkBudgets, parseTimestamp, requireRequesterRoles } from "./inputs.js";
import { assertPositiveUsd, compareUsd, equalsUsd } from "./money.js";
import { REASON_CODE, sortedUniqueReasonCodes, type ReasonCode } from "./reason-codes.js";
import { matchesCategory, matchesRequesterRole, policyApplicability, resolveRequiredApproverRole } from "./rules.js";
import type { ApprovalGrantValidationInput, ApprovalGrantValidationResult } from "./types.js";

/**
 * Validates a human approval grant against current authoritative state. Every binding is checked:
 * organization, exact request revision and amount, action, policy revision and epoch, effective
 * time, current approver identity/role/scope, separation of duties, and hard-cap capacity. A
 * changed or revoked binding invalidates the grant; an invalid grant never throws, it reports
 * stable reason codes so the caller can persist the refusal.
 */
export function validateApprovalGrant(input: ApprovalGrantValidationInput): ApprovalGrantValidationResult {
  const { request, policy, grant, approver } = input;
  const evaluatedAtMs = parseTimestamp(input.evaluatedAt, "evaluatedAt");
  if (request.organizationId !== policy.organizationId) {
    throw new FinancialRulesInputError("ORGANIZATION_MISMATCH", "policy.organizationId", "policy and request belong to different organizations");
  }
  const requesterRoles = requireRequesterRoles(input.requesterRoles, "requesterRoles");
  const amount = assertPositiveUsd(input.amount, "amount");
  const requestAmount = assertPositiveUsd(request.fullAmount, "request.fullAmount");
  const grantAmount = assertPositiveUsd(grant.exactAmount, "grant.exactAmount");

  const failures: ReasonCode[] = [];
  if (grant.organizationId !== request.organizationId || approver.organizationId !== request.organizationId) {
    failures.push(REASON_CODE.GRANT_ORGANIZATION_MISMATCH);
  }
  if (grant.requestRef.type !== "request" || grant.requestRef.id !== request.requestId) failures.push(REASON_CODE.GRANT_REQUEST_MISMATCH);
  if (grant.requestRef.revision !== request.revision) failures.push(REASON_CODE.GRANT_REVISION_MISMATCH);
  if (!equalsUsd(grantAmount, amount) || !equalsUsd(amount, requestAmount)) failures.push(REASON_CODE.GRANT_AMOUNT_MISMATCH);
  if (grant.actionType !== input.actionType) failures.push(REASON_CODE.GRANT_ACTION_MISMATCH);
  if (grant.policyRef.type !== "policy" || grant.policyRef.id !== policy.policyId || grant.policyRef.revision !== policy.revision || policyApplicability(policy, request, evaluatedAtMs).length > 0) {
    failures.push(REASON_CODE.GRANT_POLICY_MISMATCH);
  }
  if (grant.authorizationEpoch !== policy.authorizationEpoch) failures.push(REASON_CODE.GRANT_EPOCH_MISMATCH);

  const grantedAtMs = parseTimestamp(grant.grantedAt, "grant.grantedAt");
  if (evaluatedAtMs < grantedAtMs) failures.push(REASON_CODE.GRANT_NOT_YET_EFFECTIVE);
  if (evaluatedAtMs >= parseTimestamp(grant.expiresAt, "grant.expiresAt")) failures.push(REASON_CODE.GRANT_EXPIRED);

  if (approver.revoked === true) failures.push(REASON_CODE.GRANT_AUTHORITY_REVOKED);
  if (approver.approverId !== grant.approverId) failures.push(REASON_CODE.GRANT_APPROVER_IDENTITY_MISMATCH);

  const candidates = policy.rules.filter(rule => matchesCategory(rule, request) && matchesRequesterRole(rule, requesterRoles));
  const requiredApproverRole = resolveRequiredApproverRole(candidates);
  if (requiredApproverRole !== null && grant.authorityRole !== requiredApproverRole) failures.push(REASON_CODE.GRANT_APPROVER_ROLE_MISMATCH);
  if (!approver.roles.includes(grant.authorityRole)) failures.push(REASON_CODE.GRANT_APPROVER_ROLE_MISMATCH);
  if (!authorityCovers(approver.scopes, grant.scope, request.organizationId)) failures.push(REASON_CODE.GRANT_APPROVER_SCOPE_MISMATCH);
  if (!scopeWithinRequest(grant.scope, request.scopes, request.organizationId)) failures.push(REASON_CODE.GRANT_SCOPE_MISMATCH);
  if (candidates.some(rule => rule.prohibitRequesterApproval === true) && grant.approverId === request.requesterId) {
    failures.push(REASON_CODE.GRANT_SELF_APPROVAL_PROHIBITED);
  }

  if (input.budgets) {
    for (const budget of checkBudgets(input.budgets, request, evaluatedAtMs)) {
      if (budget.account.hardCap && compareUsd(budget.reserveDelta, budget.account.available) > 0) failures.push(REASON_CODE.GRANT_HARD_CAP_EXHAUSTED);
    }
  }

  const reasonCodes = sortedUniqueReasonCodes(failures);
  return { valid: reasonCodes.length === 0, reasonCodes, grantRef: { type: "approval_grant", id: grant.grantId }, requiredApproverRole };
}

/** Organization-scoped authority covers every scope inside that organization. */
function authorityCovers(scopes: readonly ScopeRef[], required: ScopeRef, organizationId: string): boolean {
  return scopes.some(scope => (scope.type === required.type && scope.id === required.id) || (scope.type === "organization" && scope.id === organizationId));
}

function scopeWithinRequest(scope: ScopeRef, requestScopes: readonly ScopeRef[], organizationId: string): boolean {
  if (scope.type === "organization") return scope.id === organizationId;
  return requestScopes.some(item => item.type === scope.type && item.id === scope.id);
}

export function approvalActionTypeFor(request: PurchaseRequestRevision): "approve_request" | "approve_amendment" {
  return request.previousRevision === null ? "approve_request" : "approve_amendment";
}
