import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApprovalGrantSchema, BudgetAccountSchema, EvidenceSchema, PolicySchema, PurchaseRequestRevisionSchema, RequestAmendmentSchema } from "@alloc/contracts";
import type { Decision, ScopeRef } from "@alloc/contracts";
import { describe, expect, it } from "vitest";
import { REASON_CODE, deriveAmendment, evaluateRequestPolicy, usd } from "../src/index.js";
import type { ApproverAuthority, GrantContext, PolicyEvaluationInput } from "../src/index.js";
import { errorCode } from "./harness.js";

interface NorthstarFixture {
  manifest: { organizationId: string; referenceDate: string };
  entities: Array<{ entityId: string; kind: string; attributes: Record<string, unknown>; access: { scopeRefs: ScopeRef[] } }>;
  policies: unknown[];
  budgets: unknown[];
  evidence: unknown[];
  scenario: {
    organizationId: string;
    requestRevisions: unknown[];
    amendments: unknown[];
    initialDecisions: Decision[];
    reviewDecision: Decision;
    approvedDecision: Decision;
    approvalGrant: unknown;
  };
}

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../company-fixtures/fixtures/northstar.json", import.meta.url)), "utf8")) as NorthstarFixture;

const policy = PolicySchema.parse(fixture.policies[0]);
const requests = fixture.scenario.requestRevisions.map(value => PurchaseRequestRevisionSchema.parse(value));
const amendments = fixture.scenario.amendments.map(value => RequestAmendmentSchema.parse(value));
const budget = BudgetAccountSchema.parse(fixture.budgets[0]);
const evidence = fixture.evidence.map(value => EvidenceSchema.parse(value));
const grant = ApprovalGrantSchema.parse(fixture.scenario.approvalGrant);
const [firstRequest, secondRequest, thirdRequest] = requests;
const requesterEntity = fixture.entities.find(entity => entity.entityId === firstRequest!.requesterId)!;
const approverEntity = fixture.entities.find(entity => entity.entityId === grant.approverId)!;
const purposeEvidence = evidence.find(item => item.kind === "document_excerpt")!;
const requesterRoles = [String(requesterEntity.attributes.role)];

/**
 * Trusted facts the 2A fixture does not model as records: the purpose is active for the trip brief
 * that carries it, and the approver holds their role and organization scope today.
 */
const purpose = {
  purpose: firstRequest!.purpose,
  active: true,
  ref: { type: "evidence", id: purposeEvidence.evidenceId, revision: purposeEvidence.revision },
};
const approverAuthority: ApproverAuthority = {
  organizationId: fixture.manifest.organizationId,
  approverId: grant.approverId,
  roles: [String(approverEntity.attributes.role)],
  scopes: approverEntity.access.scopeRefs,
};

function evaluate(index: number, evaluatedAt: string, grant?: GrantContext): ReturnType<typeof evaluateRequestPolicy> {
  const request = requests[index]!;
  const input: PolicyEvaluationInput = {
    evaluatedAt,
    request,
    policy,
    requesterRoles,
    purpose,
    cumulativeTotals: [{
      dimension: "purpose", dimensionId: request.purpose, cumulativeIncrease: request.cumulativeIncrease,
      sources: [{ type: "request", id: request.requestId, revision: request.revision }],
    }],
    evidence,
    budgets: [{ account: budget, reserveDelta: request.increaseFromPrevious }],
    ...(grant ? { grant } : {}),
  };
  return evaluateRequestPolicy(input);
}

function expectMatchesDecision(result: ReturnType<typeof evaluateRequestPolicy>, decision: Decision): void {
  expect(result.outcome).toBe(decision.outcome);
  expect(result.reasonCodes).toEqual(decision.reasonCodes);
  expect(result.policyRef).toEqual(decision.policyRef);
  expect(result.authorizationEpoch).toBe(decision.authorizationEpoch);
  expect(result.evaluatedFullAmount).toEqual(decision.evaluatedFullAmount);
  expect(result.evaluatedCumulativeIncrease).toEqual(decision.evaluatedCumulativeIncrease);
  expect(result.requiredApproverRole).toBe(decision.requiredApproverRole);
  expect(result.permittedAction).toEqual(decision.permittedAction);
  // The fixture records the request and policy facts; the evaluator also cites the budget, purpose,
  // and dimension sources it actually used.
  expect(result.factualInputs.slice(0, 2)).toEqual(decision.factualInputs);
  expect(result.evidenceRefs).toEqual(decision.evidenceRefs);
}

describe("Northstar 1A/2A fixture replay", () => {
  it("loads the frozen policy with the 1.1.0 rule vocabulary", () => {
    expect(policy.organizationId).toBe(fixture.manifest.organizationId);
    expect(policy.rules[0]).toMatchObject({
      eligibleVendorIds: [firstRequest!.vendorId],
      maximumEvidenceAgeSeconds: 15_552_000,
      requiredApproverRole: "finance_manager",
      prohibitRequesterApproval: true,
      cumulativeLimitScope: "purpose",
    });
    expect(requesterRoles).toEqual(["employee"]);
    expect(approverAuthority.roles).toEqual(["finance_manager"]);
  });

  it("replays $180 → $210 → $240 → finance-manager approval with exact outcomes and references", () => {
    const approvedFirst = evaluate(0, fixture.scenario.initialDecisions[0]!.decidedAt);
    expectMatchesDecision(approvedFirst, fixture.scenario.initialDecisions[0]!);

    const approvedSecond = evaluate(1, fixture.scenario.initialDecisions[1]!.decidedAt);
    expectMatchesDecision(approvedSecond, fixture.scenario.initialDecisions[1]!);

    const review = evaluate(2, fixture.scenario.reviewDecision.decidedAt);
    expectMatchesDecision(review, fixture.scenario.reviewDecision);
    expect(review.reasonCodes).toEqual([REASON_CODE.CUMULATIVE_INCREASE_LIMIT_EXCEEDED]);
    expect(review.permittedAction).toBeNull();

    const granted = evaluate(2, fixture.scenario.approvedDecision.decidedAt, { grant, approver: approverAuthority });
    expectMatchesDecision(granted, fixture.scenario.approvedDecision);
    expect(granted.reasonCodes).toEqual([REASON_CODE.AUTHORIZED_HUMAN_EXCEPTION]);

    expect([approvedFirst.evaluatedFullAmount.amountMinor, approvedSecond.evaluatedFullAmount.amountMinor, review.evaluatedFullAmount.amountMinor, granted.evaluatedFullAmount.amountMinor]).toEqual([18_000, 21_000, 24_000, 24_000]);
    expect([approvedFirst.evaluatedCumulativeIncrease.amountMinor, approvedSecond.evaluatedCumulativeIncrease.amountMinor, review.evaluatedCumulativeIncrease.amountMinor]).toEqual([0, 3_000, 6_000]);
    expect([approvedFirst.permittedAction?.amount.amountMinor, approvedSecond.permittedAction?.amount.amountMinor, granted.permittedAction?.amount.amountMinor]).toEqual([18_000, 21_000, 24_000]);
    expect(granted.approvalGrantRef?.id).toBe(fixture.scenario.approvedDecision.approvalGrantRef!.id);
    expect(granted.approvalGrantRef?.revision).toBeUndefined();
    expect(review.factualInputs).toContainEqual({ type: "budget_account", id: budget.budgetAccountId, revision: budget.revision });
    expect(review.factualInputs).toContainEqual(purpose.ref);
  });

  it("derives the fixture amendments and refuses the reduction", () => {
    const [firstAmendment, secondAmendment] = amendments;
    expect(deriveAmendment({
      previous: firstRequest!, revisedFullAmount: secondRequest!.fullAmount, amendmentId: firstAmendment!.amendmentId,
      reason: firstAmendment!.reason, submittedBy: firstAmendment!.submittedBy, submittedAt: firstAmendment!.submittedAt,
      provenance: firstAmendment!.provenance,
    })).toEqual(firstAmendment);
    expect(deriveAmendment({
      previous: secondRequest!, revisedFullAmount: thirdRequest!.fullAmount, amendmentId: secondAmendment!.amendmentId,
      reason: secondAmendment!.reason, submittedBy: secondAmendment!.submittedBy, submittedAt: secondAmendment!.submittedAt,
      provenance: secondAmendment!.provenance,
    })).toEqual(secondAmendment);
    expect(errorCode(() => deriveAmendment({
      previous: thirdRequest!, revisedFullAmount: secondRequest!.fullAmount, amendmentId: "amendment_buffalo_trip_3",
      reason: "Reduce the trip", submittedBy: "employee_maya_chen", submittedAt: "2026-09-12T14:21:00Z",
      provenance: secondAmendment!.provenance,
    }))).toBe("AMENDMENT_NOT_AN_INCREASE");
  });

  it("refuses the requester's own authority for the review", () => {
    const requesterGrant = { ...grant, approverId: firstRequest!.requesterId, authorityRole: "employee", requestRef: { type: "request", id: thirdRequest!.requestId, revision: thirdRequest!.revision }, exactAmount: thirdRequest!.fullAmount };
    const result = evaluate(2, fixture.scenario.approvedDecision.decidedAt, {
      grant: requesterGrant, approver: { ...approverAuthority, approverId: firstRequest!.requesterId, roles: requesterRoles },
    });
    expect(result.outcome).toBe("review_required");
    expect(result.reasonCodes).toContain(REASON_CODE.GRANT_SELF_APPROVAL_PROHIBITED);
    expect(result.reasonCodes).toContain(REASON_CODE.GRANT_APPROVER_ROLE_MISMATCH);
  });

  it("keeps the third revision out of automatic approval even after a grant expires", () => {
    const expired = evaluate(2, "2026-09-12T14:46:00Z", { grant, approver: approverAuthority });
    expect(expired.outcome).toBe("review_required");
    expect(expired.reasonCodes).toContain(REASON_CODE.GRANT_EXPIRED);
    expect(expired.reasonCodes).toContain(REASON_CODE.CUMULATIVE_INCREASE_LIMIT_EXCEEDED);
  });

  it("does not authorize the third revision against a stale policy revision", () => {
    const stalePolicy = PolicySchema.parse({ ...policy, revision: policy.revision + 1, authorizationEpoch: policy.authorizationEpoch });
    const result = evaluateRequestPolicy({
      evaluatedAt: fixture.scenario.approvedDecision.decidedAt,
      request: thirdRequest!,
      policy: stalePolicy,
      requesterRoles,
      purpose,
      cumulativeTotals: [{ dimension: "purpose", dimensionId: thirdRequest!.purpose, cumulativeIncrease: thirdRequest!.cumulativeIncrease, sources: [{ type: "request", id: thirdRequest!.requestId, revision: thirdRequest!.revision }] }],
      evidence,
      budgets: [{ account: budget, reserveDelta: usd(3_000) }],
      grant: { grant, approver: approverAuthority },
    });
    expect(result.outcome).toBe("review_required");
    expect(result.reasonCodes).toContain(REASON_CODE.GRANT_POLICY_MISMATCH);
  });
});
