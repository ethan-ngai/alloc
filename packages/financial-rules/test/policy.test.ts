import type { PolicyRule } from "@alloc/contracts";
import { describe, expect, it } from "vitest";
import { REASON_CODE, evaluateRequestPolicy, usd } from "../src/index.js";
import type { PolicyEvaluationInput, PolicyOutcome, ReasonCode, UsdMoney } from "../src/index.js";
import {
  APPROVER_ID, EVALUATED_AT, ORGANIZATION_ID, REQUESTER_ID, approvalGrant, approverAuthority, budget,
  cumulativeTotal, evaluationInput, evidence, policy, purposeState, request, requestReference, reviewRequest,
  reviewTotals, rule,
} from "./harness.js";
import type { Mutable } from "./harness.js";
import { errorCode, errorMessage } from "./harness.js";

/** A rule with every optional condition removed, so only the selector matches. */
const bareRule = (overrides: Mutable<PolicyRule>): PolicyRule => rule({
  requireActivePurpose: false, requiredEvidenceKinds: [], maximumFullAmount: undefined, maximumCumulativeIncrease: undefined,
  eligibleVendorIds: undefined, maximumEvidenceAgeSeconds: undefined, requiredApproverRole: undefined,
  prohibitRequesterApproval: undefined, cumulativeLimitScope: undefined, ...overrides,
});

const denyRule = bareRule({ ruleId: "rule_deny_travel", effect: "deny" });
const reviewRule = bareRule({ ruleId: "rule_review_travel", effect: "require_review" });
const softBudget = (available: number) => budget({ hardCap: false, authorized: usd(available), recognizedSpend: usd(0), outstandingCommitments: usd(0) });
const reserved = (available: number, reserveDelta: number) => [{ account: budget({ authorized: usd(available), recognizedSpend: usd(0), outstandingCommitments: usd(0) }), reserveDelta: usd(reserveDelta) }];
const totalsAt = (cumulativeIncrease: number) => [cumulativeTotal({ cumulativeIncrease: usd(cumulativeIncrease) })];
const overCumulative = { request: request({ cumulativeIncrease: usd(5_001) }), cumulativeTotals: totalsAt(5_001) };

const cases: Array<[string, Mutable<PolicyEvaluationInput>, PolicyOutcome, ReasonCode[]]> = [
  ["approves automatically when every permit condition holds", {}, "approved", [REASON_CODE.WITHIN_CUMULATIVE_ALLOWANCE]],
  ["treats full-amount equality as permitted", { request: request({ fullAmount: usd(25_000) }) }, "approved", [REASON_CODE.WITHIN_CUMULATIVE_ALLOWANCE]],
  ["reviews one cent above the full-amount limit", { request: request({ fullAmount: usd(25_001) }) }, "review_required", [REASON_CODE.FULL_AMOUNT_EXCEEDS_AUTO_LIMIT]],
  ["treats cumulative-limit equality as permitted", { request: request({ cumulativeIncrease: usd(5_000) }), cumulativeTotals: totalsAt(5_000) }, "approved", [REASON_CODE.WITHIN_CUMULATIVE_ALLOWANCE]],
  ["reviews one cent above the cumulative limit", overCumulative, "review_required", [REASON_CODE.CUMULATIVE_INCREASE_LIMIT_EXCEEDED]],
  ["permits a reservation exactly equal to a hard cap", { budgets: reserved(3_000, 3_000) }, "approved", [REASON_CODE.WITHIN_CUMULATIVE_ALLOWANCE]],
  ["denies when a hard cap cannot absorb the reservation", { budgets: reserved(3_000, 3_001) }, "denied", [REASON_CODE.HARD_CAP_CAPACITY_INSUFFICIENT]],
  ["permits a reservation exactly equal to a soft cap", { budgets: [{ account: softBudget(3_000), reserveDelta: usd(3_000) }] }, "approved", [REASON_CODE.WITHIN_CUMULATIVE_ALLOWANCE]],
  ["reviews when a soft cap cannot absorb the reservation", { budgets: [{ account: softBudget(3_000), reserveDelta: usd(3_001) }] }, "review_required", [REASON_CODE.SOFT_CAP_CAPACITY_INSUFFICIENT]],
  ["denies when an explicit deny rule matches", { policy: policy({ rules: [denyRule, rule()] }) }, "denied", [REASON_CODE.EXPLICIT_DENY_RULE]],
  ["reviews when a require_review rule matches alongside a permit", { policy: policy({ rules: [reviewRule, rule()] }) }, "review_required", [REASON_CODE.POLICY_REQUIRES_REVIEW]],
  ["does not deny when the deny rule's own limit is unmet", { policy: policy({ rules: [bareRule({ ruleId: "rule_deny_travel", effect: "deny", maximumFullAmount: usd(1_000) }), rule()] }) }, "review_required", [REASON_CODE.FULL_AMOUNT_EXCEEDS_AUTO_LIMIT]],
  ["denies on a hard cap even when permit conditions fail", { ...overCumulative, budgets: reserved(3_000, 3_001) }, "denied", [REASON_CODE.HARD_CAP_CAPACITY_INSUFFICIENT]],
  ["reports both a hard-cap denial and an explicit deny", { policy: policy({ rules: [denyRule, rule()] }), budgets: reserved(3_000, 3_001) }, "denied", [REASON_CODE.EXPLICIT_DENY_RULE, REASON_CODE.HARD_CAP_CAPACITY_INSUFFICIENT]],
  ["reports a soft cap alongside a permit failure", { ...overCumulative, budgets: [{ account: softBudget(3_000), reserveDelta: usd(3_001) }] }, "review_required", [REASON_CODE.CUMULATIVE_INCREASE_LIMIT_EXCEEDED, REASON_CODE.SOFT_CAP_CAPACITY_INSUFFICIENT]],
  ["keeps the policy effective at its inclusive start", { policy: policy({ effectiveFrom: EVALUATED_AT }) }, "approved", [REASON_CODE.WITHIN_CUMULATIVE_ALLOWANCE]],
  ["expires the policy at its exclusive end", { policy: policy({ effectiveTo: EVALUATED_AT }) }, "review_required", [REASON_CODE.POLICY_EXPIRED]],
  ["reviews before the policy is effective", { policy: policy({ effectiveFrom: "2026-09-12T15:00:00Z" }) }, "review_required", [REASON_CODE.POLICY_NOT_YET_EFFECTIVE]],
  ["treats a null policy end as unbounded", { policy: policy({ effectiveTo: null }) }, "approved", [REASON_CODE.WITHIN_CUMULATIVE_ALLOWANCE]],
  ["matches a policy scoped to a request scope", { policy: policy({ scope: { type: "department", id: "department_field_engineering" } }) }, "approved", [REASON_CODE.WITHIN_CUMULATIVE_ALLOWANCE]],
  ["reviews a policy scoped outside the request", { policy: policy({ scope: { type: "project", id: "project_atlas" } }) }, "review_required", [REASON_CODE.POLICY_SCOPE_MISMATCH]],
  ["reviews when the requester holds no rule role", { requesterRoles: ["contractor"] }, "review_required", [REASON_CODE.REQUESTER_ROLE_NOT_ELIGIBLE]],
  ["reviews when no rule covers the category", { policy: policy({ rules: [rule({ categoryIds: ["category_food"] })] }) }, "review_required", [REASON_CODE.POLICY_COVERAGE_MISSING]],
  ["reviews a vendor outside the allowlist", { request: request({ vendorId: "vendor_other_supplier" }) }, "review_required", [REASON_CODE.VENDOR_NOT_ELIGIBLE]],
  ["reviews a request with no vendor when the rule names vendors", { request: request({ vendorId: undefined }) }, "review_required", [REASON_CODE.VENDOR_NOT_ELIGIBLE]],
  ["skips the vendor check when the rule names none", { request: request({ vendorId: undefined }), policy: policy({ rules: [rule({ eligibleVendorIds: undefined })] }) }, "approved", [REASON_CODE.WITHIN_CUMULATIVE_ALLOWANCE]],
  ["reviews when required evidence is absent", { evidence: [] }, "review_required", [REASON_CODE.EVIDENCE_MISSING]],
  ["reviews when only another evidence kind exists", { policy: policy({ rules: [rule({ requiredEvidenceKinds: ["metric"] })] }) }, "review_required", [REASON_CODE.EVIDENCE_MISSING]],
  ["skips the evidence check when the rule requires none", { evidence: [], policy: policy({ rules: [rule({ requiredEvidenceKinds: [] })] }) }, "approved", [REASON_CODE.WITHIN_CUMULATIVE_ALLOWANCE]],
  ["ignores evidence from another organization", { evidence: [evidence({ organizationId: "org_other_tenant" })] }, "review_required", [REASON_CODE.EVIDENCE_MISSING]],
  ["reviews stale evidence", { policy: policy({ rules: [rule({ maximumEvidenceAgeSeconds: 3_600 })] }), evidence: [evidence({ provenance: { kind: "synthetic", trust: "evidence", sourceInstanceId: "source_northstar_simulator", sourceObjectId: "purpose-brief-stale", sourceRevision: "2", occurredAt: "2026-09-12T12:00:00Z", observedAt: "2026-09-12T12:00:00Z" } })] }, "review_required", [REASON_CODE.EVIDENCE_STALE]],
  ["keeps evidence fresh at exactly the maximum age", { policy: policy({ rules: [rule({ maximumEvidenceAgeSeconds: 7_200 })] }), evidence: [evidence({ provenance: { kind: "synthetic", trust: "evidence", sourceInstanceId: "source_northstar_simulator", sourceObjectId: "purpose-brief-boundary", sourceRevision: "2", occurredAt: "2026-09-12T12:00:00Z", observedAt: "2026-09-12T12:00:00Z" } })] }, "approved", [REASON_CODE.WITHIN_CUMULATIVE_ALLOWANCE]],
  ["reviews without a trusted purpose fact", { purpose: null }, "review_required", [REASON_CODE.MISSING_TRUSTED_FACTS]],
  ["reviews when the trusted purpose differs", { purpose: purposeState({ purpose: "Other trip" }) }, "review_required", [REASON_CODE.MISSING_TRUSTED_FACTS]],
  ["reviews an inactive purpose", { purpose: purposeState({ active: false }) }, "review_required", [REASON_CODE.PURPOSE_NOT_ACTIVE]],
  ["reviews when the declared dimension has no trusted total", { cumulativeTotals: [] }, "review_required", [REASON_CODE.MISSING_TRUSTED_FACTS]],
  ["measures the employee dimension", { request: request({ cumulativeIncrease: usd(5_001) }), cumulativeTotals: [cumulativeTotal({ dimension: "employee", dimensionId: REQUESTER_ID, cumulativeIncrease: usd(5_001) })], policy: policy({ rules: [rule({ cumulativeLimitScope: "employee" })] }) }, "review_required", [REASON_CODE.CUMULATIVE_INCREASE_LIMIT_EXCEEDED]],
  ["measures the project dimension", { request: request({ cumulativeIncrease: usd(5_001) }), cumulativeTotals: [cumulativeTotal({ dimension: "project", dimensionId: "project_beacon", cumulativeIncrease: usd(5_001) })], policy: policy({ rules: [rule({ cumulativeLimitScope: "project" })] }) }, "review_required", [REASON_CODE.CUMULATIVE_INCREASE_LIMIT_EXCEEDED]],
  ["defaults an omitted cumulative scope to purpose", { cumulativeTotals: [cumulativeTotal({ dimension: "employee", dimensionId: REQUESTER_ID, cumulativeIncrease: usd(5_001) })], policy: policy({ rules: [rule({ cumulativeLimitScope: undefined })] }) }, "review_required", [REASON_CODE.MISSING_TRUSTED_FACTS]],
  ["reviews a project-scoped rule when the request has no project", { request: request({ projectId: undefined }), cumulativeTotals: [cumulativeTotal({ dimension: "project", dimensionId: "project_beacon", cumulativeIncrease: usd(5_001) })], policy: policy({ rules: [rule({ cumulativeLimitScope: "project" })] }) }, "review_required", [REASON_CODE.MISSING_TRUSTED_FACTS]],
];

describe("evaluateRequestPolicy", () => {
  it.each(cases)("%s", (_name, overrides, outcome, reasonCodes) => {
    const result = evaluateRequestPolicy(evaluationInput(overrides));
    expect(result.outcome).toBe(outcome);
    expect(result.reasonCodes).toEqual(reasonCodes);
  });

  it("is deterministic for identical inputs", () => {
    const input = evaluationInput({ ...overCumulative });
    expect(evaluateRequestPolicy(input)).toEqual(evaluateRequestPolicy(input));
  });

  it("reports matched rules, versions, references, and the permitted action", () => {
    const result = evaluateRequestPolicy(evaluationInput());
    expect(Object.keys(result).sort()).toEqual([
      "authorizationEpoch", "evaluatedCumulativeIncrease", "evaluatedFullAmount", "evidenceRefs", "factualInputs",
      "matchedRuleIds", "outcome", "permittedAction", "policyRef", "reasonCodes", "requiredApproverRole",
    ]);
    expect(result.policyRef).toEqual({ type: "policy", id: "policy_travel", revision: 1 });
    expect(result.authorizationEpoch).toBe(1);
    expect(result.matchedRuleIds).toEqual(["rule_small_purchase"]);
    expect(result.evaluatedFullAmount).toEqual({ amountMinor: 21_000, currency: "USD" });
    expect(result.evaluatedCumulativeIncrease).toEqual({ amountMinor: 3_000, currency: "USD" });
    expect(result.permittedAction).toEqual({ type: "simulate_purchase", amount: { amountMinor: 21_000, currency: "USD" } });
    expect(result.requiredApproverRole).toBeNull();
    expect(result.factualInputs).toEqual([
      { type: "request", id: "request_buffalo_trip", revision: 2 },
      { type: "policy", id: "policy_travel", revision: 1 },
      { type: "budget_account", id: "budget_field_travel", revision: 4 },
      { type: "evidence", id: "evidence_trip_active", revision: 1 },
    ]);
    expect(result.evidenceRefs).toEqual([{ type: "evidence", id: "evidence_trip_active", revision: 1 }]);
  });

  it("reports the dimension total it compared and deduplicates references", () => {
    const result = evaluateRequestPolicy(evaluationInput({
      request: reviewRequest,
      cumulativeTotals: [cumulativeTotal({ cumulativeIncrease: usd(6_000), sources: [requestReference(3), requestReference(3)] })],
    }));
    expect(result.evaluatedCumulativeIncrease).toEqual({ amountMinor: 6_000, currency: "USD" });
    expect(result.requiredApproverRole).toBe("finance_manager");
    expect(result.permittedAction).toBeNull();
    expect(result.factualInputs.filter(ref => ref.type === "request")).toEqual([{ type: "request", id: "request_buffalo_trip", revision: 3 }]);
  });

  it("deduplicates repeated evidence references", () => {
    const result = evaluateRequestPolicy(evaluationInput({ evidence: [evidence(), evidence()] }));
    expect(result.evidenceRefs).toEqual([{ type: "evidence", id: "evidence_trip_active", revision: 1 }]);
  });

  it("retains the source revision when evidence fails freshness", () => {
    const stale = evidence({ provenance: {
      kind: "synthetic", trust: "evidence", sourceInstanceId: "source_northstar_simulator",
      sourceObjectId: "purpose-brief-stale", sourceRevision: "2",
      occurredAt: "2026-09-12T12:00:00Z", observedAt: "2026-09-12T12:00:00Z",
    } });
    const result = evaluateRequestPolicy(evaluationInput({
      policy: policy({ rules: [rule({ maximumEvidenceAgeSeconds: 3_600 })] }),
      evidence: [stale],
    }));
    expect(result.reasonCodes).toEqual([REASON_CODE.EVIDENCE_STALE]);
    expect(result.evidenceRefs).toEqual([{ type: "evidence", id: stale.evidenceId, revision: stale.revision }]);
  });

  it("reports every matched candidate rule in policy order", () => {
    const result = evaluateRequestPolicy(evaluationInput({ policy: policy({ rules: [rule({ ruleId: "rule_second" }), rule({ ruleId: "rule_first" })] }) }));
    expect(result.matchedRuleIds).toEqual(["rule_second", "rule_first"]);
  });

  it("never reports rules from a policy that is out of scope", () => {
    const result = evaluateRequestPolicy(evaluationInput({ policy: policy({ scope: { type: "project", id: "project_atlas" } }) }));
    expect(result.matchedRuleIds).toEqual([]);
    expect(result.evidenceRefs).toEqual([]);
    expect(result.requiredApproverRole).toBeNull();
  });

  it("preserves hard-cap denial when matching rules have conflicting approver roles", () => {
    const result = evaluateRequestPolicy(evaluationInput({
      policy: policy({ rules: [
        rule({ ruleId: "rule_finance", requiredApproverRole: "finance_manager" }),
        bareRule({ ruleId: "rule_controller", effect: "require_review", requiredApproverRole: "controller" }),
      ] }),
      budgets: reserved(3_000, 3_001),
    }));
    expect(result.outcome).toBe("denied");
    expect(result.reasonCodes).toEqual([REASON_CODE.HARD_CAP_CAPACITY_INSUFFICIENT]);
  });
});

describe("evaluateRequestPolicy with a grant", () => {
  const reviewInput = (overrides: Mutable<PolicyEvaluationInput> = {}) => evaluationInput({
    evaluatedAt: "2026-09-12T14:16:00Z",
    request: reviewRequest,
    cumulativeTotals: reviewTotals,
    grant: { grant: approvalGrant({ requestRef: requestReference(3), exactAmount: usd(24_000) }), approver: approverAuthority() },
    ...overrides,
  });

  it("lifts a review to approval with a valid finance-manager grant", () => {
    const result = evaluateRequestPolicy(reviewInput());
    expect(result.outcome).toBe("approved");
    expect(result.reasonCodes).toEqual([REASON_CODE.AUTHORIZED_HUMAN_EXCEPTION]);
    expect(result.approvalGrantRef).toEqual({ type: "approval_grant", id: "grant_finance_review" });
    expect(result.permittedAction).toEqual({ type: "simulate_purchase", amount: { amountMinor: 24_000, currency: "USD" } });
    expect(result.requiredApproverRole).toBeNull();
    expect(result.evaluatedCumulativeIncrease).toEqual({ amountMinor: 6_000, currency: "USD" });
  });

  it("keeps the review when the grant binds an older revision", () => {
    const result = evaluateRequestPolicy(reviewInput({ grant: { grant: approvalGrant({ exactAmount: usd(24_000) }), approver: approverAuthority() } }));
    expect(result.outcome).toBe("review_required");
    expect(result.reasonCodes).toEqual([REASON_CODE.CUMULATIVE_INCREASE_LIMIT_EXCEEDED, REASON_CODE.GRANT_REVISION_MISMATCH]);
  });

  it("keeps the review when the approver authority is revoked", () => {
    const result = evaluateRequestPolicy(reviewInput({ grant: { grant: approvalGrant({ requestRef: requestReference(3), exactAmount: usd(24_000) }), approver: approverAuthority({ revoked: true }) } }));
    expect(result.outcome).toBe("review_required");
    expect(result.reasonCodes).toContain(REASON_CODE.GRANT_AUTHORITY_REVOKED);
  });

  it("retains stale evidence while refusing a malformed grant binding", () => {
    const stale = evidence({ provenance: {
      kind: "synthetic", trust: "evidence", sourceInstanceId: "source_northstar_simulator",
      sourceObjectId: "purpose-brief-stale", sourceRevision: "2",
      occurredAt: "2026-09-12T12:00:00Z", observedAt: "2026-09-12T12:00:00Z",
    } });
    const malformedGrant = approvalGrant({
      requestRef: { type: "policy", id: "request_buffalo_trip", revision: 3 },
      exactAmount: usd(24_000),
    });
    const result = evaluateRequestPolicy(reviewInput({
      policy: policy({ rules: [rule({ maximumEvidenceAgeSeconds: 3_600 })] }),
      evidence: [stale],
      grant: { grant: malformedGrant, approver: approverAuthority() },
    }));
    expect(result.outcome).toBe("review_required");
    expect(result.reasonCodes).toEqual([
      REASON_CODE.CUMULATIVE_INCREASE_LIMIT_EXCEEDED,
      REASON_CODE.EVIDENCE_STALE,
      REASON_CODE.GRANT_REQUEST_MISMATCH,
    ]);
    expect(result.evidenceRefs).toEqual([{ type: "evidence", id: stale.evidenceId, revision: stale.revision }]);
  });

  it("refuses requester self-approval", () => {
    const requester = approverAuthority({ approverId: REQUESTER_ID, roles: ["employee"] });
    const result = evaluateRequestPolicy(reviewInput({
      policy: policy({ rules: [rule({ requiredApproverRole: undefined })] }),
      grant: { grant: approvalGrant({ requestRef: requestReference(3), exactAmount: usd(24_000), approverId: REQUESTER_ID, authorityRole: "employee" }), approver: requester },
    }));
    expect(result.outcome).toBe("review_required");
    expect(result.reasonCodes).toEqual([REASON_CODE.CUMULATIVE_INCREASE_LIMIT_EXCEEDED, REASON_CODE.GRANT_SELF_APPROVAL_PROHIBITED]);
  });

  it("never lets a grant override a hard cap", () => {
    const result = evaluateRequestPolicy(reviewInput({ budgets: reserved(3_000, 3_001) }));
    expect(result.outcome).toBe("denied");
    expect(result.reasonCodes).toEqual([REASON_CODE.HARD_CAP_CAPACITY_INSUFFICIENT]);
    expect(result.approvalGrantRef).toBeUndefined();
  });

  it("ignores a grant when the request already approves automatically", () => {
    const result = evaluateRequestPolicy(evaluationInput({ grant: { grant: approvalGrant(), approver: approverAuthority() } }));
    expect(result.outcome).toBe("approved");
    expect(result.reasonCodes).toEqual([REASON_CODE.WITHIN_CUMULATIVE_ALLOWANCE]);
  });
});

describe("evaluateRequestPolicy invalid inputs", () => {
  const invalid: Array<[string, Mutable<PolicyEvaluationInput>, string, string]> = [
    ["rejects a non-USD reservation", { budgets: [{ account: budget(), reserveDelta: { amountMinor: 3_000, currency: "EUR" } as unknown as UsdMoney }] }, "CURRENCY_MISMATCH", "budgets[0].reserveDelta.currency"],
    ["rejects a non-USD request amount", { request: request({ fullAmount: { amountMinor: 21_000, currency: "EUR" } as unknown as UsdMoney }) }, "CURRENCY_MISMATCH", "request.fullAmount.currency"],
    ["rejects an unsafe minor unit", { request: request({ fullAmount: { amountMinor: 2 ** 53, currency: "USD" } as unknown as UsdMoney }) }, "UNSAFE_INTEGER", "request.fullAmount.amountMinor"],
    ["rejects a non-positive full amount", { request: request({ fullAmount: usd(0) }) }, "NON_POSITIVE_AMOUNT", "request.fullAmount"],
    ["rejects a negative cumulative increase", { request: request({ cumulativeIncrease: usd(-1) }) }, "NEGATIVE_AMOUNT", "request.cumulativeIncrease"],
    ["rejects a revision increase above its cumulative increase", { request: request({ increaseFromPrevious: usd(4_000) }) }, "INCONSISTENT_CUMULATIVE_TOTAL", "request.increaseFromPrevious"],
    ["rejects a loose evaluation timestamp", { evaluatedAt: "2026-09-12" }, "INVALID_TIMESTAMP", "evaluatedAt"],
    ["rejects a mismatched policy organization", { policy: policy({ organizationId: "org_other_tenant" }) }, "ORGANIZATION_MISMATCH", "policy.organizationId"],
    ["rejects empty requester roles", { requesterRoles: [] }, "MISSING_REQUIRED_INPUT", "requesterRoles"],
    ["rejects a stale budget snapshot", { budgets: [{ account: budget({ available: usd(1) }), reserveDelta: usd(3_000) }] }, "INCONSISTENT_BUDGET", "budgets[0].account.available"],
    ["rejects a budget outside the evaluation period", { budgets: [{ account: budget({ periodStart: "2026-10-01", periodEnd: "2026-10-31" }), reserveDelta: usd(3_000) }] }, "BUDGET_PERIOD_MISMATCH", "budgets[0].account"],
    ["rejects a budget from another organization", { budgets: [{ account: budget({ organizationId: "org_other_tenant" }), reserveDelta: usd(3_000) }] }, "ORGANIZATION_MISMATCH", "budgets[0].account.organizationId"],
    ["rejects duplicate dimension totals", { cumulativeTotals: [cumulativeTotal(), cumulativeTotal()] }, "DUPLICATE_CUMULATIVE_DIMENSION", "cumulativeTotals[1]"],
    ["rejects a total below the revision increase", { cumulativeTotals: [cumulativeTotal({ cumulativeIncrease: usd(2_999) })] }, "INCONSISTENT_CUMULATIVE_TOTAL", "cumulativeTotals[0].cumulativeIncrease"],
    ["rejects a total without sources", { cumulativeTotals: [cumulativeTotal({ cumulativeIncrease: usd(6_000), sources: [] })] }, "MISSING_REQUIRED_INPUT", "cumulativeTotals[0].sources"],
    ["rejects an unknown cumulative dimension", { cumulativeTotals: [cumulativeTotal({ dimension: "cost_center" as never })] }, "MISSING_REQUIRED_INPUT", "cumulativeTotals[0].dimension"],
    ["rejects a negative reservation", { budgets: [{ account: budget(), reserveDelta: usd(-1) }] }, "NEGATIVE_AMOUNT", "budgets[0].reserveDelta"],
    ["rejects a non-USD full-amount rule limit", { policy: policy({ rules: [rule({ maximumFullAmount: { amountMinor: 25_000, currency: "EUR" } as unknown as UsdMoney })] }) }, "CURRENCY_MISMATCH", "rule.rule_small_purchase.maximumFullAmount.currency"],
    ["rejects a non-USD cumulative rule limit", { policy: policy({ rules: [rule({ maximumCumulativeIncrease: { amountMinor: 5_000, currency: "EUR" } as unknown as UsdMoney })] }) }, "CURRENCY_MISMATCH", "rule.rule_small_purchase.maximumCumulativeIncrease.currency"],
  ];

  it.each(invalid)("%s", (_name, overrides, code, path) => {
    const input = evaluationInput(overrides);
    expect(errorCode(() => evaluateRequestPolicy(input))).toBe(code);
    expect(errorMessage(() => evaluateRequestPolicy(input))).toContain(`at ${path}:`);
  });

  it("names the error type and code in the thrown error", () => {
    expect(errorMessage(() => evaluateRequestPolicy(evaluationInput({ evaluatedAt: "yesterday" })))).toMatch(/^INVALID_TIMESTAMP at evaluatedAt: /);
  });

  it("rejects conflicting approver roles independently of rule order", () => {
    const financeRule = rule({ ruleId: "rule_finance", requiredApproverRole: "finance_manager" });
    const controllerRule = bareRule({ ruleId: "rule_controller", effect: "require_review", requiredApproverRole: "controller" });
    for (const rules of [[financeRule, controllerRule], [controllerRule, financeRule]]) {
      expect(errorCode(() => evaluateRequestPolicy(evaluationInput({ policy: policy({ rules }) })))).toBe("INCONSISTENT_APPROVER_ROLE");
    }
  });
});

describe("evaluated amount passthrough", () => {
  it("reports the evaluated request revision amounts, not the raw inputs", () => {
    const result = evaluateRequestPolicy(evaluationInput({ request: request({ fullAmount: usd(24_000), cumulativeIncrease: usd(6_000) }), cumulativeTotals: reviewTotals }));
    expect(result.evaluatedFullAmount).toEqual<UsdMoney>({ amountMinor: 24_000, currency: "USD" });
  });

  it("reports the approver role declared by the matched rule", () => {
    const result = evaluateRequestPolicy(evaluationInput({ policy: policy({ rules: [rule({ requiredApproverRole: "controller" })] }) }));
    expect(result.outcome).toBe("approved");
    expect(result.requiredApproverRole).toBeNull();
    const reviewed = evaluateRequestPolicy(evaluationInput({ policy: policy({ rules: [rule({ requiredApproverRole: "controller" })] }), ...overCumulative }));
    expect(reviewed.requiredApproverRole).toBe("controller");
  });

  it("carries the policy organization, revision, and authorization epoch", () => {
    const result = evaluateRequestPolicy(evaluationInput({ policy: policy({ revision: 3, authorizationEpoch: 7, organizationId: ORGANIZATION_ID }) }));
    expect(result.policyRef).toEqual({ type: "policy", id: "policy_travel", revision: 3 });
    expect(result.authorizationEpoch).toBe(7);
    expect(APPROVER_ID).toBe("employee_avery_finance");
  });
});
