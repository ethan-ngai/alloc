import { CONTRACT_SCHEMA_VERSION } from "@alloc/contracts";
import type { Commitment, Posting } from "@alloc/contracts";
import type { PostingCorrection } from "../contract-types.js";
import { MockContractError } from "../errors.js";
import { usd } from "../money.js";
import {
  appendActivity, assertRegisteredScopes, assertRevisionMatch, budgetOf, postingSummary, refreshBudget,
  refreshCommitmentState, requireExpectation,
} from "./context.js";
import type { Handler } from "./context.js";

export const recordPosting: Handler<"postings.record"> = (ctx, payload) => {
  if (ctx.company.postings.some((posting) => posting.postingId === payload.postingId)) {
    throw new MockContractError("IDEMPOTENCY_CONFLICT", `posting ${payload.postingId} already exists`, { postingId: payload.postingId });
  }
  assertRegisteredScopes(ctx, payload.scopes);

  let commitment: Commitment | undefined;
  if (payload.commitmentRef !== undefined) {
    const ref = { type: "commitment", id: payload.commitmentRef.id };
    const expectation = requireExpectation(ctx, ref);
    commitment = ctx.company.commitments.get(payload.commitmentRef.id);
    if (!commitment) {
      throw new MockContractError("NOT_FOUND", `commitment ${payload.commitmentRef.id} is not known to ${ctx.company.organizationId}`);
    }
    assertRevisionMatch(ref, expectation.expectedRevision, commitment.revision);
  }
  if (commitment && payload.amount.amountMinor > commitment.outstandingAmount.amountMinor) {
    throw new MockContractError("VALIDATION_FAILED", `posting ${payload.postingId} exceeds the outstanding commitment`, {
      reasonCode: "postingExceedsOutstandingCommitment",
      outstandingAmount: commitment.outstandingAmount.amountMinor,
      attemptedAmount: payload.amount.amountMinor,
    });
  }

  const posting: Posting = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: ctx.company.organizationId,
    postingId: payload.postingId,
    revision: payload.revision,
    amount: usd(payload.amount.amountMinor),
    occurredAt: payload.occurredAt,
    status: payload.status,
    sourceRef: structuredClone(payload.sourceRef),
    scopes: structuredClone(payload.scopes),
    provenance: structuredClone(payload.provenance),
    ...(payload.commitmentRef === undefined ? {} : { commitmentRef: structuredClone(payload.commitmentRef) }),
  };
  ctx.company.postings.push(posting);

  const budget = budgetOf(ctx);
  budget.recognizedSpend = usd(budget.recognizedSpend.amountMinor + posting.amount.amountMinor);
  if (commitment) {
    budget.outstandingCommitments = usd(budget.outstandingCommitments.amountMinor - posting.amount.amountMinor);
    commitment.outstandingAmount = usd(commitment.outstandingAmount.amountMinor - posting.amount.amountMinor);
    commitment.revision += 1;
    refreshCommitmentState(commitment);
  }
  refreshBudget(budget);

  appendActivity(ctx, {
    activityId: ctx.ids.next("activity"),
    type: "posting",
    occurredAt: posting.occurredAt,
    subjectRef: { type: "posting", id: posting.postingId, revision: posting.revision },
    summary: postingSummary(posting),
  }, posting.scopes);
  return posting;
};

/**
 * Signed correction against an existing posting. Only recognized spend moves: a correction is not a
 * commitment release, so outstanding commitments are untouched.
 */
export const correctPosting: Handler<"postings.correct"> = (ctx, payload) => {
  const ref = { type: "posting", id: payload.originalPostingRef.id };
  const expectation = requireExpectation(ctx, ref);
  const original = ctx.company.postings.find((posting) => posting.postingId === payload.originalPostingRef.id);
  if (!original) {
    throw new MockContractError("NOT_FOUND", `posting ${payload.originalPostingRef.id} is not known to ${ctx.company.organizationId}`);
  }
  assertRevisionMatch(ref, expectation.expectedRevision, original.revision);

  const amountMinor = payload.amount.amountMinor;
  if (Math.abs(amountMinor) > original.amount.amountMinor) {
    throw new MockContractError("VALIDATION_FAILED", `correction ${payload.correctionId} exceeds posting ${original.postingId}`, {
      reasonCode: "correctionExceedsOriginalAmount",
      originalAmount: original.amount.amountMinor,
      correctionAmount: amountMinor,
    });
  }
  const budget = budgetOf(ctx);
  if (budget.recognizedSpend.amountMinor + amountMinor < 0) {
    throw new MockContractError("VALIDATION_FAILED", "correction would drive recognized spend negative", {
      reasonCode: "correctionDrivesRecognizedSpendNegative",
      recognizedSpend: budget.recognizedSpend.amountMinor,
      correctionAmount: amountMinor,
    });
  }

  const correction: PostingCorrection = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: ctx.company.organizationId,
    correctionId: payload.correctionId,
    originalPostingRef: { type: "posting", id: original.postingId, revision: original.revision },
    amount: usd(amountMinor),
    reason: payload.reason,
    occurredAt: payload.occurredAt,
    provenance: structuredClone(payload.provenance),
  };
  ctx.company.corrections.push(correction);
  budget.recognizedSpend = usd(budget.recognizedSpend.amountMinor + amountMinor);
  refreshBudget(budget);
  return correction;
};
