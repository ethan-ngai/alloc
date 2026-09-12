import { northstarScenario } from "@alloc/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { ERROR_STATUS } from "../src/errors.js";
import { HUMAN_REVIEW_APPROVED_REASON, HUMAN_REVIEW_DENIED_REASON } from "../src/policy.js";
import { northstarPack } from "../src/packs.js";
import {
  callError, callOk, commandMeta, companyFixture, moneyMinor, queryMeta, requestJson, startMock,
  versionExpectation,
} from "./harness.js";

const company = companyFixture(northstarPack);
const ORG = company.organizationId;
const CATEGORY_ID = company.categoryIds[0]!;
const COMMITMENT_REF = { type: "commitment", id: company.commitmentId };
const POSTING_OCCURRED_AT = "2026-09-12T14:30:00Z";
const SEEDED_RECOGNIZED_SPEND = 12_000;

interface BudgetFacts {
  authorized: number;
  recognized: number;
  outstanding: number;
  available: number;
}

async function budgetFacts(url: string): Promise<BudgetFacts> {
  const { data } = await callOk(url, "memory.query", {
    meta: queryMeta("correlation_flow_budget", ORG),
    payload: { query: "Budget", scopes: [company.tenantScope], page: { limit: 25 } },
  });
  const factOf = (label: string): number => {
    const fact = data.facts.find((candidate) => candidate.label === label);
    if (!fact) throw new Error(`missing budget fact ${label}`);
    return moneyMinor(fact.value, label);
  };
  return {
    authorized: factOf("Budget authorized amount"),
    recognized: factOf("Budget recognized spend"),
    outstanding: factOf("Budget outstanding commitments"),
    available: factOf("Budget available amount"),
  };
}

function provenance(sourceObjectId: string) {
  return {
    kind: "synthetic" as const,
    trust: "authoritative" as const,
    sourceInstanceId: "source_flow_driver",
    sourceObjectId,
    sourceRevision: "1",
    occurredAt: POSTING_OCCURRED_AT,
    observedAt: POSTING_OCCURRED_AT,
  };
}

function amendInput(
  commandId: string,
  correlationId: string,
  requestId: string,
  expectedRevision: number,
  revisedAmountMinor: number,
) {
  return {
    meta: commandMeta(commandId, correlationId, ORG, [versionExpectation({ type: "request", id: requestId }, expectedRevision)]),
    payload: {
      requestId,
      revisedFullAmount: { amountMinor: revisedAmountMinor, currency: "USD" },
      reason: `Amendment to ${revisedAmountMinor} minor units`,
    },
  };
}

function createInput(commandId: string, correlationId: string, fullAmountMinor: number) {
  return {
    meta: commandMeta(commandId, correlationId, ORG),
    payload: {
      requesterId: company.requesterId,
      purpose: "Buffalo Beacon pilot trip",
      fullAmount: { amountMinor: fullAmountMinor, currency: "USD" },
      categoryId: CATEGORY_ID,
      vendorId: company.vendorId,
      ...(company.projectId === null ? {} : { projectId: company.projectId }),
      scopes: company.requestScopes,
    },
  };
}

async function fetchCommitment(url: string, requestId: string) {
  const { data } = await callOk(url, "requests.get", {
    meta: queryMeta("correlation_flow_get", ORG),
    payload: { requestId },
  });
  return data;
}

describe("mock-client flows over HTTP", () => {
  it("success: amendments within the auto-approval limits reserve budget exactly once", async () => {
    const { api, url } = await startMock();
    try {
      const { status, data } = await callOk(url, "requests.amend", amendInput("command_flow_amend_1", "correlation_flow_amend_1", company.requestId, 1, 21_000));
      expect(status).toBe(200);
      expect(data.request.revision).toBe(2);
      expect(data.request.previousRevision).toBe(1);
      expect(data.request.increaseFromPrevious.amountMinor).toBe(3_000);
      expect(data.request.cumulativeIncrease.amountMinor).toBe(3_000);
      expect(data.request.evaluationState).toBe("approved");
      expect(data.decision.outcome).toBe("approved");
      expect(data.decision.reasonCodes).toEqual(["WITHIN_AUTO_APPROVAL_LIMITS"]);
      expect(data.decision.requiredApproverRole).toBeNull();
      expect(data.decision.permittedAction?.amount.amountMinor).toBe(21_000);

      const fetched = await fetchCommitment(url, company.requestId);
      expect(fetched.commitment?.amount.amountMinor).toBe(21_000);
      expect(fetched.commitment?.outstandingAmount.amountMinor).toBe(21_000);
      expect(fetched.decisions).toHaveLength(2);

      const budget = await budgetFacts(url);
      expect(budget).toEqual({ authorized: 50_000, recognized: 12_000, outstanding: 21_000, available: 17_000 });
    } finally {
      await api.close();
    }
  });

  it("success: requests.create approves and reserves the amount exactly once", async () => {
    const { api, url } = await startMock();
    try {
      const { data } = await callOk(url, "requests.create", createInput("command_flow_create", "correlation_flow_create", 18_000));
      expect(data.revision).toBe(1);
      expect(data.previousRevision).toBeNull();
      expect(data.evaluationState).toBe("approved");
      expect(data.increaseFromPrevious.amountMinor).toBe(0);
      expect(data.cumulativeIncrease.amountMinor).toBe(0);

      const fetched = await fetchCommitment(url, data.requestId);
      expect(fetched.decisions).toHaveLength(1);
      expect(fetched.decisions[0]?.reasonCodes).toEqual(["WITHIN_AUTO_APPROVAL_LIMITS"]);
      expect(fetched.commitment?.amount.amountMinor).toBe(18_000);
      expect(fetched.commitment?.outstandingAmount.amountMinor).toBe(18_000);
      expect(fetched.commitment?.state).toBe("outstanding");

      const budget = await budgetFacts(url);
      expect(budget.recognized).toBe(SEEDED_RECOGNIZED_SPEND);
      expect(budget.outstanding).toBe(18_000 + 18_000);
      expect(budget.available).toBe(2_000);
    } finally {
      await api.close();
    }
  });

  it("pending review: a $60 cumulative increase needs finance_manager approval and reconciles once", async () => {
    const { api, url } = await startMock();
    try {
      await callOk(url, "requests.amend", amendInput("command_flow_review_1", "correlation_flow_review_1", company.requestId, 1, 21_000));
      const reviewed = await callOk(url, "requests.amend", amendInput("command_flow_review_2", "correlation_flow_review_2", company.requestId, 2, 24_000));
      expect(reviewed.data.request.revision).toBe(3);
      expect(reviewed.data.request.evaluationState).toBe("review_required");
      expect(reviewed.data.request.cumulativeIncrease.amountMinor).toBe(6_000);
      expect(reviewed.data.decision.outcome).toBe("review_required");
      expect(reviewed.data.decision.reasonCodes).toEqual(["CUMULATIVE_INCREASE_LIMIT_EXCEEDED"]);
      expect(reviewed.data.decision.requiredApproverRole).toBe("finance_manager");
      expect(reviewed.data.decision.permittedAction).toBeNull();

      const awaitingReview = await fetchCommitment(url, company.requestId);
      expect(awaitingReview.commitment?.outstandingAmount.amountMinor).toBe(21_000);
      expect(awaitingReview.decisions).toHaveLength(3);

      const decided = await callOk(url, "reviews.decide", {
        meta: commandMeta("command_flow_decide", "correlation_flow_decide", ORG),
        payload: { requestId: company.requestId, requestRevision: 3, outcome: "approved", rationale: "Reviewed and approved" },
      }, { principalId: company.approverId });
      expect(decided.data.decision.outcome).toBe("approved");
      expect(decided.data.decision.reasonCodes).toEqual([HUMAN_REVIEW_APPROVED_REASON]);
      expect(decided.data.commitment?.outstandingAmount.amountMinor).toBe(24_000);
      const commitmentRevision = decided.data.commitment?.revision ?? 1;

      const posting = await callOk(url, "postings.record", {
        meta: commandMeta("command_flow_posting", "correlation_flow_posting", ORG, [versionExpectation(COMMITMENT_REF, commitmentRevision)]),
        payload: {
          postingId: "posting_flow_trip",
          revision: 1,
          amount: { amountMinor: 24_000, currency: "USD" },
          occurredAt: POSTING_OCCURRED_AT,
          status: "posted",
          commitmentRef: { ...COMMITMENT_REF, revision: commitmentRevision },
          sourceRef: { type: "source_delivery", id: "delivery_flow_trip", revision: 1 },
          scopes: company.requestScopes,
          provenance: provenance("flow-trip-lodging"),
        },
      }, { principalId: company.approverId });
      expect(posting.data.amount.amountMinor).toBe(24_000);

      const settled = await fetchCommitment(url, company.requestId);
      expect(settled.commitment?.state).toBe("posted");
      expect(settled.commitment?.outstandingAmount.amountMinor).toBe(0);
      expect(settled.request.fullAmount.amountMinor).toBe(northstarScenario.expectedTotals.approvedAmount.amountMinor);
      expect(settled.request.cumulativeIncrease.amountMinor).toBe(northstarScenario.expectedTotals.cumulativeIncrease.amountMinor);
      expect(posting.data.amount.amountMinor + (settled.commitment?.outstandingAmount.amountMinor ?? 0))
        .toBe(northstarScenario.expectedTotals.commitmentToSpend.amountMinor);

      const budget = await budgetFacts(url);
      expect(budget.recognized).toBe(SEEDED_RECOGNIZED_SPEND + northstarScenario.expectedTotals.recognizedSpend.amountMinor);
      expect(budget.outstanding).toBe(northstarScenario.expectedTotals.outstandingCommitments.amountMinor);
      expect(budget.available).toBe(14_000);
    } finally {
      await api.close();
    }
  });

  it("denial: the hard limit denies outright and human review can deny a reviewed request", async () => {
    const { api, url } = await startMock();
    try {
      const hardDenied = await callOk(url, "requests.create", createInput("command_flow_deny_hard", "correlation_flow_deny_hard", 150_000));
      expect(hardDenied.data.evaluationState).toBe("denied");
      const hardDeniedState = await fetchCommitment(url, hardDenied.data.requestId);
      expect(hardDeniedState.decisions[0]?.reasonCodes).toEqual(["FULL_AMOUNT_EXCEEDS_HARD_LIMIT"]);
      expect(hardDeniedState.decisions[0]?.permittedAction).toBeNull();
      expect(hardDeniedState.commitment).toBeNull();

      const reviewed = await callOk(url, "requests.create", createInput("command_flow_deny_review", "correlation_flow_deny_review", 30_000));
      expect(reviewed.data.evaluationState).toBe("review_required");
      const reviewedState = await fetchCommitment(url, reviewed.data.requestId);
      expect(reviewedState.decisions[0]?.reasonCodes).toEqual(["FULL_AMOUNT_EXCEEDS_AUTO_LIMIT"]);
      expect(reviewedState.commitment).toBeNull();

      const denied = await callOk(url, "reviews.decide", {
        meta: commandMeta("command_flow_deny_human", "correlation_flow_deny_human", ORG),
        payload: { requestId: reviewed.data.requestId, requestRevision: 1, outcome: "denied", rationale: "Outside the approved pilot scope" },
      }, { principalId: company.approverId });
      expect(denied.data.decision.outcome).toBe("denied");
      expect(denied.data.decision.reasonCodes).toEqual([HUMAN_REVIEW_DENIED_REASON]);
      expect(denied.data.commitment).toBeNull();

      const deniedState = await fetchCommitment(url, reviewed.data.requestId);
      expect(deniedState.request.evaluationState).toBe("review_required");
      expect(deniedState.decisions.map((decision) => decision.outcome)).toEqual(["review_required", "denied"]);
      expect(deniedState.commitment).toBeNull();

      const budget = await budgetFacts(url);
      expect(budget.outstanding).toBe(18_000);
      expect(budget.recognized).toBe(SEEDED_RECOGNIZED_SPEND);
    } finally {
      await api.close();
    }
  });

  it("stale state: stale revisions, unknown requests, and denied requests fail with contract codes", async () => {
    const { api, url } = await startMock();
    try {
      const stale = await callError(url, "requests.amend", amendInput("command_flow_stale", "correlation_flow_stale", company.requestId, 2, 21_000));
      expect(stale.status).toBe(ERROR_STATUS.STALE_VERSION);
      expect(stale.status).toBe(409);
      expect(stale.error.code).toBe("STALE_VERSION");
      expect(stale.error.retryable).toBe(false);
      expect(stale.error.details).toMatchObject({ expected: 2, actual: 1 });

      await callOk(url, "requests.amend", amendInput("command_flow_stale_1", "correlation_flow_stale_1", company.requestId, 1, 21_000));
      const reviewed = await callOk(url, "requests.amend", amendInput("command_flow_stale_2", "correlation_flow_stale_2", company.requestId, 2, 24_000));
      expect(reviewed.data.request.revision).toBe(3);

      const staleDecision = await callError(url, "reviews.decide", {
        meta: commandMeta("command_flow_stale_decide", "correlation_flow_stale_decide", ORG),
        payload: { requestId: company.requestId, requestRevision: 2, outcome: "approved", rationale: "Stale approval" },
      }, { principalId: company.approverId });
      expect(staleDecision.status).toBe(409);
      expect(staleDecision.error.code).toBe("STALE_VERSION");

      const missing = await callError(url, "requests.get", {
        meta: queryMeta("correlation_flow_missing", ORG),
        payload: { requestId: "request_flow_missing" },
      });
      expect(missing.status).toBe(404);
      expect(missing.error.code).toBe("NOT_FOUND");

      const denied = await callOk(url, "requests.create", createInput("command_flow_denied_create", "correlation_flow_denied_create", 150_000));
      expect(denied.data.evaluationState).toBe("denied");
      const deniedAmendment = await callError(url, "requests.amend", amendInput("command_flow_denied_amend", "correlation_flow_denied_amend", denied.data.requestId, 1, 160_000));
      expect(deniedAmendment.status).toBe(409);
      expect(deniedAmendment.error.code).toBe("POLICY_DENIED");
      expect(deniedAmendment.error.details).toMatchObject({ reasonCode: "REQUEST_DENIED" });
    } finally {
      await api.close();
    }
  });

  it("API errors: fault injection, malformed bodies, authority, routing, and idempotency", async () => {
    const { api, url } = await startMock();
    try {
      const faulted = await callError(url, "requests.get", {
        meta: queryMeta("correlation_flow_fault", ORG),
        payload: { requestId: company.requestId },
      }, { fault: "DEPENDENCY_UNAVAILABLE" });
      expect(faulted.status).toBe(503);
      expect(faulted.error.retryable).toBe(true);
      expect(faulted.error.message).toBe("Mock fault injection: DEPENDENCY_UNAVAILABLE");
      expect(faulted.error.details).toMatchObject({ injected: true, operation: "requests.get" });

      const unknownFault = await callError(url, "requests.get", {
        meta: queryMeta("correlation_flow_fault_unknown", ORG),
        payload: { requestId: company.requestId },
      }, { fault: "NOT_A_CODE" });
      expect(unknownFault.status).toBe(400);
      expect(unknownFault.error.code).toBe("VALIDATION_FAILED");

      const malformed = await callError(url, "requests.get", "{", {});
      expect(malformed.status).toBe(400);
      expect(malformed.error.code).toBe("VALIDATION_FAILED");
      expect(malformed.error.details).toMatchObject({ reasonCode: "malformedJson" });

      const foreignOrganization = await callError(url, "requests.get", {
        meta: queryMeta("correlation_flow_foreign", "org_flow_missing"),
        payload: { requestId: company.requestId },
      });
      expect(foreignOrganization.status).toBe(403);
      expect(foreignOrganization.error.code).toBe("ACCESS_DENIED");

      const unauthorized = await callError(url, "reviews.decide", {
        meta: commandMeta("command_flow_unauthorized", "correlation_flow_unauthorized", ORG),
        payload: { requestId: company.requestId, requestRevision: 1, outcome: "approved", rationale: "Requester self-approval" },
      }, { principalId: company.requesterId });
      expect(unauthorized.status).toBe(403);
      expect(unauthorized.error.code).toBe("AUTHORITY_DENIED");

      const wrongMethod = await requestJson(url, "/operations/requests.get", { method: "GET" });
      expect(wrongMethod.status).toBe(404);
      const noRoute = await requestJson(url, "/nope", { method: "POST", body: "{}" });
      expect(noRoute.status).toBe(404);
      expect(JSON.stringify(noRoute.body)).toContain("no operation route for POST /nope");

      const before = await budgetFacts(url);
      const first = await callOk(url, "requests.create", createInput("command_flow_idempotent", "correlation_flow_idempotent_1", 18_000));
      const replay = await callOk(url, "requests.create", createInput("command_flow_idempotent", "correlation_flow_idempotent_2", 18_000));
      expect(replay.data).toEqual(first.data);
      expect(replay.data.requestId).toBe(first.data.requestId);
      const after = await budgetFacts(url);
      expect(after.outstanding).toBe(before.outstanding + 18_000);
      expect(after.outstanding).toBe(36_000);

      const conflict = await callError(url, "requests.create", createInput("command_flow_idempotent", "correlation_flow_idempotent_3", 19_000));
      expect(conflict.status).toBe(409);
      expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
      const unchanged = await budgetFacts(url);
      expect(unchanged.outstanding).toBe(36_000);
    } finally {
      await api.close();
    }
  });
});
