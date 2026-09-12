import { FinancialRulesInputError } from "./errors.js";
import { approvalActionTypeFor, validateApprovalGrant } from "./grants.js";
import { checkBudgets, checkCumulativeTotals, parseTimestamp, requireRequesterRoles } from "./inputs.js";
import { assertNonNegativeUsd, assertPositiveUsd, compareUsd } from "./money.js";
import { REASON_CODE, dedupeRefs, refOfPolicy, refOfRequest, sortedUniqueReasonCodes, type ReasonCode } from "./reason-codes.js";
import { evaluateRule, matchesCategory, matchesRequesterRole, policyApplicability, resolveRequiredApproverRole } from "./rules.js";
import type { PolicyEvaluationInput, PolicyEvaluationResult, PolicyOutcome } from "./types.js";

/**
 * Deterministic policy evaluation over trusted structured inputs. Precedence is
 * `deny` > `require_review` > `permit`: an explicit deny rule or an exhausted hard cap denies,
 * review requirements and any failed mandatory check route to human review, and only full permit
 * coverage with every check passing approves automatically. A supplied grant is validated against
 * current authority and can lift a review to approval, but never overrides a denial.
 */
export function evaluateRequestPolicy(input: PolicyEvaluationInput): PolicyEvaluationResult {
  const { request, policy } = input;
  const evaluatedAtMs = parseTimestamp(input.evaluatedAt, "evaluatedAt");
  if (request.organizationId !== policy.organizationId) {
    throw new FinancialRulesInputError("ORGANIZATION_MISMATCH", "policy.organizationId", "policy and request belong to different organizations");
  }
  const requesterRoles = requireRequesterRoles(input.requesterRoles, "requesterRoles");
  const fullAmount = assertPositiveUsd(request.fullAmount, "request.fullAmount");
  const cumulativeIncrease = assertNonNegativeUsd(request.cumulativeIncrease, "request.cumulativeIncrease");
  const increaseFromPrevious = assertNonNegativeUsd(request.increaseFromPrevious, "request.increaseFromPrevious");
  if (compareUsd(increaseFromPrevious, cumulativeIncrease) > 0) {
    throw new FinancialRulesInputError("INCONSISTENT_CUMULATIVE_TOTAL", "request.increaseFromPrevious", "revision increase exceeds the revision's cumulative increase");
  }
  const cumulativeTotals = checkCumulativeTotals(input.cumulativeTotals, request);
  const budgets = checkBudgets(input.budgets, request, evaluatedAtMs);

  const policyRef = refOfPolicy(policy);
  const requestRef = refOfRequest(request);
  const factualInputs = dedupeRefs([
    requestRef,
    policyRef,
    ...cumulativeTotals.flatMap(total => total.sources),
    ...budgets.map(budget => budget.ref),
    ...(input.purpose?.ref ? [input.purpose.ref] : []),
  ]);
  const hardCapFailures = budgets.filter(budget => budget.account.hardCap && compareUsd(budget.reserveDelta, budget.account.available) > 0);
  const softCapFailures = budgets.filter(budget => !budget.account.hardCap && compareUsd(budget.reserveDelta, budget.account.available) > 0);

  const applicability = policyApplicability(policy, request, evaluatedAtMs);
  const categoryRules = applicability.length === 0 ? policy.rules.filter(rule => matchesCategory(rule, request)) : [];
  const candidates = categoryRules.filter(rule => matchesRequesterRole(rule, requesterRoles));
  const evaluations = candidates.map(rule => evaluateRule(rule, { request, evaluatedAtMs, purpose: input.purpose, cumulativeTotals, evidence: input.evidence }));

  const evidenceRefs = dedupeRefs(evaluations.flatMap(evaluation => evaluation.evidenceRefs));
  const evaluatedCumulativeIncrease = evaluations.find(evaluation => evaluation.cumulativeUsed !== null)?.cumulativeUsed ?? cumulativeIncrease;
  const matchedRuleIds = candidates.map(rule => rule.ruleId);
  const denyRules = evaluations.filter(evaluation => evaluation.rule.effect === "deny" && evaluation.failures.length === 0);
  const requiredApproverRole = hardCapFailures.length > 0 || denyRules.length > 0 ? null : resolveRequiredApproverRole(candidates);

  const decide = (outcome: PolicyOutcome, reasonCodes: readonly ReasonCode[], extra: Partial<PolicyEvaluationResult> = {}): PolicyEvaluationResult => ({
    outcome,
    reasonCodes: sortedUniqueReasonCodes(reasonCodes),
    matchedRuleIds,
    policyRef,
    authorizationEpoch: policy.authorizationEpoch,
    evaluatedFullAmount: fullAmount,
    evaluatedCumulativeIncrease,
    factualInputs,
    evidenceRefs,
    requiredApproverRole,
    permittedAction: null,
    ...extra,
  });

  if (hardCapFailures.length > 0 || denyRules.length > 0) {
    return decide("denied", [
      ...(hardCapFailures.length > 0 ? [REASON_CODE.HARD_CAP_CAPACITY_INSUFFICIENT] : []),
      ...(denyRules.length > 0 ? [REASON_CODE.EXPLICIT_DENY_RULE] : []),
    ], { requiredApproverRole: null });
  }

  const reviewRules = evaluations.filter(evaluation => evaluation.rule.effect === "require_review" && evaluation.failures.length === 0);
  const permittedRules = evaluations.filter(evaluation => evaluation.rule.effect === "permit" && evaluation.failures.length === 0);
  const coverage: ReasonCode[] = candidates.length === 0
    ? [categoryRules.length > 0 ? REASON_CODE.REQUESTER_ROLE_NOT_ELIGIBLE : REASON_CODE.POLICY_COVERAGE_MISSING]
    : permittedRules.length === 0 && evaluations.every(evaluation => evaluation.failures.length === 0)
      ? [REASON_CODE.POLICY_COVERAGE_MISSING]
      : [];

  const reviewCodes: ReasonCode[] = [
    ...applicability,
    ...(applicability.length === 0 ? coverage : []),
    ...(reviewRules.length > 0 ? [REASON_CODE.POLICY_REQUIRES_REVIEW] : []),
    ...(softCapFailures.length > 0 ? [REASON_CODE.SOFT_CAP_CAPACITY_INSUFFICIENT] : []),
    ...evaluations.flatMap(evaluation => evaluation.failures),
  ];

  if (reviewCodes.length > 0) {
    const grant = input.grant;
    if (!grant) return decide("review_required", reviewCodes);
    const validation = validateApprovalGrant({
      evaluatedAt: input.evaluatedAt,
      grant: grant.grant,
      request,
      policy,
      requesterRoles,
      approver: grant.approver,
      actionType: approvalActionTypeFor(request),
      amount: fullAmount,
      budgets: input.budgets,
    });
    if (!validation.valid) return decide("review_required", [...reviewCodes, ...validation.reasonCodes]);
    return decide("approved", [REASON_CODE.AUTHORIZED_HUMAN_EXCEPTION], {
      requiredApproverRole: null,
      approvalGrantRef: { type: "approval_grant", id: grant.grant.grantId },
      permittedAction: { type: "simulate_purchase", amount: fullAmount },
    });
  }

  return decide("approved", [REASON_CODE.WITHIN_CUMULATIVE_ALLOWANCE], {
    requiredApproverRole: null,
    permittedAction: { type: "simulate_purchase", amount: fullAmount },
  });
}
