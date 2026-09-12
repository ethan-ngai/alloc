import { CONTRACT_SCHEMA_VERSION } from "@alloc/contracts";
import type { Commitment, Decision } from "@alloc/contracts";
import { MockContractError } from "../errors.js";
import { usd } from "../money.js";
import { HUMAN_REVIEW_APPROVED_REASON, HUMAN_REVIEW_DENIED_REASON } from "../policy.js";
import {
  appendActivity, applyCommitmentReserve, assertCapacity, budgetOf, commitmentFor, decisionRefOf,
  decisionSummary, evidenceRef, policyRef, requestRefOf, requireRequest,
} from "./context.js";
import type { Handler } from "./context.js";

/**
 * Human review. Authority comes from the authenticated principal only — the payload cannot carry a
 * grant, and the mock never resolves one.
 */
export const decideReview: Handler<"reviews.decide"> = (ctx, payload) => {
  if (ctx.principal.authorityRole !== "finance_manager") {
    throw new MockContractError(
      "AUTHORITY_DENIED",
      `principal ${ctx.principal.principalId} does not hold finance_manager authority`,
      { authorityRole: ctx.principal.authorityRole },
    );
  }
  const request = requireRequest(ctx, payload.requestId);
  const departmentScope = request.scopes.find((scope) => scope.type === "department");
  const inScope = departmentScope !== undefined
    && ctx.principal.scopeRefs.some((scope) => scope.type === departmentScope.type && scope.id === departmentScope.id);
  if (!inScope) {
    throw new MockContractError(
      "AUTHORITY_DENIED",
      `principal ${ctx.principal.principalId} has no authority over ${payload.requestId}`,
      { requiredScope: departmentScope ?? null },
    );
  }
  if (payload.requestRevision !== request.revision) {
    throw new MockContractError(
      "STALE_VERSION",
      `request ${request.requestId} is at revision ${request.revision}, not ${payload.requestRevision}`,
      { expected: payload.requestRevision, actual: request.revision, ref: { type: "request", id: request.requestId } },
    );
  }
  if (request.evaluationState !== "review_required") {
    throw new MockContractError(
      "POLICY_DENIED",
      `request ${request.requestId} is ${request.evaluationState}, not awaiting review`,
      { reasonCode: "REQUEST_NOT_AWAITING_REVIEW" },
    );
  }
  const terminalDecision = ctx.company.decisions.find((decision) => (
    decision.requestRef.id === request.requestId
    && decision.requestRef.revision === request.revision
    && decision.reasonCodes.some((code) => code === HUMAN_REVIEW_APPROVED_REASON || code === HUMAN_REVIEW_DENIED_REASON)
  ));
  if (terminalDecision) {
    throw new MockContractError(
      "POLICY_DENIED",
      `request ${request.requestId} revision ${request.revision} already has a human decision`,
      { reasonCode: "REQUEST_ALREADY_DECIDED", decisionId: terminalDecision.decisionId, outcome: terminalDecision.outcome },
    );
  }

  const budget = budgetOf(ctx);
  const existing = commitmentFor(ctx, request.requestId);
  const amountMinor = request.fullAmount.amountMinor;
  const approved = payload.outcome === "approved";
  if (approved) assertCapacity(budget, amountMinor - (existing?.amount.amountMinor ?? 0));

  const decidedAt = ctx.clock.now();
  const decision: Decision = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: ctx.company.organizationId,
    decisionId: ctx.ids.next("decision"),
    requestRef: requestRefOf(request),
    outcome: payload.outcome,
    reasonCodes: [approved ? HUMAN_REVIEW_APPROVED_REASON : HUMAN_REVIEW_DENIED_REASON],
    policyRef: policyRef(),
    authorizationEpoch: 1,
    evaluatedFullAmount: usd(amountMinor),
    evaluatedCumulativeIncrease: usd(request.cumulativeIncrease.amountMinor),
    factualInputs: [requestRefOf(request), policyRef()],
    evidenceRefs: [evidenceRef()],
    requiredApproverRole: null,
    permittedAction: approved ? { type: "simulate_purchase", amount: usd(amountMinor) } : null,
    decidedAt,
  };
  ctx.company.decisions.push(decision);

  const commitment: Commitment | null = approved
    ? applyCommitmentReserve(ctx, request, decision, amountMinor)
    : existing ?? null;

  appendActivity(ctx, {
    activityId: ctx.ids.next("activity"),
    type: "decision",
    occurredAt: decision.decidedAt,
    subjectRef: decisionRefOf(decision),
    summary: decisionSummary(decision, request.requestId, request.revision),
  }, request.scopes);
  return { decision, commitment };
};
