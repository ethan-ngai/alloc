import { CONTRACT_SCHEMA_VERSION } from "@alloc/contracts";
import type { Decision, PurchaseRequestRevision, RequestAmendment } from "@alloc/contracts";
import { MockContractError } from "../errors.js";
import { usd } from "../money.js";
import { evaluateMockPolicy } from "../policy.js";
import type { PolicyEvaluation } from "../policy.js";
import {
  appendActivity, applyCommitmentReserve, assertCapacity, assertEntityRegistered, assertNoExpectations,
  assertRegisteredScopes, assertRevisionMatch, budgetOf, decisionRefOf, decisionSummary, provenanceFor,
  commitmentFor, evidenceRef, policyRef, requestRefOf, requestSummary, requireExpectation, requireRequest,
} from "./context.js";
import type { Handler, HandlerContext } from "./context.js";

/**
 * Every mock decision references the pack's seeded evidence record because the seeded policy rule
 * requires the `trip_active` evidence kind; no catalogued operation can resolve an approval grant,
 * so `approvalGrantRef` is deliberately never emitted.
 */
function buildDecision(ctx: HandlerContext, request: PurchaseRequestRevision, evaluation: PolicyEvaluation, decidedAt: string): Decision {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: ctx.company.organizationId,
    decisionId: ctx.ids.next("decision"),
    requestRef: requestRefOf(request),
    outcome: evaluation.outcome,
    reasonCodes: evaluation.reasonCodes,
    policyRef: policyRef(),
    authorizationEpoch: 1,
    evaluatedFullAmount: usd(request.fullAmount.amountMinor),
    evaluatedCumulativeIncrease: usd(request.cumulativeIncrease.amountMinor),
    factualInputs: [requestRefOf(request), policyRef()],
    evidenceRefs: [evidenceRef()],
    requiredApproverRole: evaluation.outcome === "review_required" ? "finance_manager" : null,
    permittedAction: evaluation.outcome === "approved" ? { type: "simulate_purchase", amount: usd(request.fullAmount.amountMinor) } : null,
    decidedAt,
  };
}

export const createRequest: Handler<"requests.create"> = (ctx, payload) => {
  assertNoExpectations(ctx);
  assertRegisteredScopes(ctx, payload.scopes);
  assertEntityRegistered(ctx, "employee", payload.requesterId);
  assertEntityRegistered(ctx, "category", payload.categoryId);
  if (payload.vendorId !== undefined) assertEntityRegistered(ctx, "vendor", payload.vendorId);
  if (payload.projectId !== undefined) assertEntityRegistered(ctx, "project", payload.projectId);

  const budget = budgetOf(ctx);
  const evaluation = evaluateMockPolicy({
    fullAmountMinor: payload.fullAmount.amountMinor,
    cumulativeIncreaseMinor: 0,
    reserveDeltaMinor: payload.fullAmount.amountMinor,
    availableMinor: budget.available.amountMinor,
    hardCap: budget.hardCap,
  });

  const requestId = ctx.ids.next("request");
  const submittedAt = ctx.clock.tick();
  const request: PurchaseRequestRevision = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: ctx.company.organizationId,
    requestId,
    revision: 1,
    previousRevision: null,
    requesterId: payload.requesterId,
    purpose: payload.purpose,
    fullAmount: usd(payload.fullAmount.amountMinor),
    increaseFromPrevious: usd(0),
    cumulativeIncrease: usd(0),
    categoryId: payload.categoryId,
    scopes: structuredClone(payload.scopes),
    evaluationState: evaluation.outcome,
    submittedAt,
    provenance: provenanceFor(ctx, `${requestId}-submission`),
    ...(payload.vendorId === undefined ? {} : { vendorId: payload.vendorId }),
    ...(payload.projectId === undefined ? {} : { projectId: payload.projectId }),
  };
  const decision = buildDecision(ctx, request, evaluation, submittedAt);

  ctx.company.requests.set(requestId, [request]);
  ctx.company.decisions.push(decision);
  if (evaluation.outcome === "approved") {
    assertCapacity(budget, request.fullAmount.amountMinor);
    applyCommitmentReserve(ctx, request, decision, request.fullAmount.amountMinor);
  }

  appendActivity(ctx, {
    activityId: ctx.ids.next("activity"),
    type: "request",
    occurredAt: request.submittedAt,
    subjectRef: requestRefOf(request),
    summary: requestSummary(request),
  }, request.scopes);
  appendActivity(ctx, {
    activityId: ctx.ids.next("activity"),
    type: "decision",
    occurredAt: decision.decidedAt,
    subjectRef: decisionRefOf(decision),
    summary: decisionSummary(decision, request.requestId, request.revision),
  }, request.scopes);
  return request;
};

export const amendRequest: Handler<"requests.amend"> = (ctx, payload) => {
  const ref = { type: "request", id: payload.requestId };
  const expectation = requireExpectation(ctx, ref);
  const request = requireRequest(ctx, payload.requestId);
  assertRevisionMatch(ref, expectation.expectedRevision, request.revision);
  if (request.evaluationState === "denied") {
    throw new MockContractError("POLICY_DENIED", `request ${request.requestId} was denied and cannot be amended`, { reasonCode: "REQUEST_DENIED" });
  }

  const revisedAmount = payload.revisedFullAmount.amountMinor;
  const increase = revisedAmount - request.fullAmount.amountMinor;
  if (increase <= 0) {
    throw new MockContractError("VALIDATION_FAILED", "revisedFullAmount must increase the requested amount", {
      reasonCode: "revisedAmountNotAnIncrease",
      previousFullAmount: request.fullAmount.amountMinor,
      revisedFullAmount: revisedAmount,
    });
  }
  const cumulativeIncrease = request.cumulativeIncrease.amountMinor + increase;
  const budget = budgetOf(ctx);
  const evaluation = evaluateMockPolicy({
    fullAmountMinor: revisedAmount,
    cumulativeIncreaseMinor: cumulativeIncrease,
    reserveDeltaMinor: increase,
    availableMinor: budget.available.amountMinor,
    hardCap: budget.hardCap,
  });

  const toRevision = request.revision + 1;
  const submittedAt = ctx.clock.tick();
  const revised: PurchaseRequestRevision = {
    ...request,
    revision: toRevision,
    previousRevision: request.revision,
    fullAmount: usd(revisedAmount),
    increaseFromPrevious: usd(increase),
    cumulativeIncrease: usd(cumulativeIncrease),
    evaluationState: evaluation.outcome,
    submittedAt,
    provenance: provenanceFor(ctx, `${request.requestId}-amendment-${toRevision}`),
  };
  const amendment: RequestAmendment = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: ctx.company.organizationId,
    amendmentId: ctx.ids.next("amendment"),
    requestId: request.requestId,
    fromRevision: request.revision,
    toRevision,
    previousFullAmount: usd(request.fullAmount.amountMinor),
    revisedFullAmount: usd(revisedAmount),
    increase: usd(increase),
    cumulativeIncrease: usd(cumulativeIncrease),
    reason: payload.reason,
    submittedBy: ctx.principal.principalId,
    submittedAt,
    provenance: provenanceFor(ctx, `${request.requestId}-amendment-${toRevision}-submission`),
  };
  const decision = buildDecision(ctx, revised, evaluation, submittedAt);

  ctx.company.requests.get(request.requestId)!.push(revised);
  ctx.company.amendments.push(amendment);
  ctx.company.decisions.push(decision);
  if (evaluation.outcome === "approved") {
    assertCapacity(budget, increase);
    applyCommitmentReserve(ctx, revised, decision, revisedAmount);
  }

  appendActivity(ctx, {
    activityId: ctx.ids.next("activity"),
    type: "request",
    occurredAt: revised.submittedAt,
    subjectRef: requestRefOf(revised),
    summary: requestSummary(revised),
  }, revised.scopes);
  appendActivity(ctx, {
    activityId: ctx.ids.next("activity"),
    type: "decision",
    occurredAt: decision.decidedAt,
    subjectRef: decisionRefOf(decision),
    summary: decisionSummary(decision, revised.requestId, revised.revision),
  }, revised.scopes);
  return { request: revised, decision };
};

export const getRequest: Handler<"requests.get"> = (ctx, payload) => {
  const request = requireRequest(ctx, payload.requestId);
  return {
    request,
    decisions: ctx.company.decisions.filter((decision) => decision.requestRef.id === payload.requestId),
    commitment: commitmentFor(ctx, payload.requestId) ?? null,
  };
};
