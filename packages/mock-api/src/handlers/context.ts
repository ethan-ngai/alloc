import { CONTRACT_SCHEMA_VERSION } from "@alloc/contracts";
import type { Commitment, Decision, DurableJobMessage, ForecastSnapshot, OperationInput, OperationName, Posting, PurchaseRequestRevision } from "@alloc/contracts";
import { SEEDED_EVIDENCE_ID, SEEDED_POLICY_ID } from "../packs.js";
import { usd } from "../money.js";
import type { ActivityItem, BudgetAccount, PageInfo, Provenance, RecordRef, ScopeRef, VersionExpectation } from "../contract-types.js";
import type { Clock } from "../clock.js";
import { MockContractError } from "../errors.js";
import type { IdFactory } from "../ids.js";
import { createProvenance } from "../packs.js";
import type { CompanyState, MockStore, OperationData, Principal } from "../store.js";

/** Handlers receive the payload only; the parsed meta travels on the context. */
export interface HandlerMeta {
  correlationId: string;
  commandId?: string;
  expectedVersions?: VersionExpectation[];
}

export interface HandlerContext {
  readonly company: CompanyState;
  readonly principal: Principal;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly store: MockStore;
  readonly meta: HandlerMeta;
}

export type Handler<Name extends OperationName> = (
  ctx: HandlerContext,
  payload: OperationInput<Name>["payload"],
) => OperationData<Name>;

export type AnyHandler = (ctx: HandlerContext, payload: never) => unknown;

export function paginate<T>(items: T[], page: { limit: number; cursor?: string | undefined }): { items: T[]; page: PageInfo } {
  const raw = page.cursor ?? "";
  const offset = raw === "" ? 0 : Number(raw);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new MockContractError("VALIDATION_FAILED", `cursor ${raw} is not a zero-based offset`, { cursor: raw });
  }
  const slice = items.slice(offset, offset + page.limit);
  const truncated = offset + slice.length < items.length;
  return { items: slice, page: { nextCursor: truncated ? String(offset + slice.length) : null, truncated } };
}

export function requestSummary(request: PurchaseRequestRevision): string {
  return `Request ${request.requestId} revision ${request.revision} ${request.evaluationState}`;
}

export function decisionSummary(decision: Decision, requestId: string, requestRevision: number): string {
  return `Decision ${decision.decisionId} ${decision.outcome} for ${requestId} revision ${requestRevision}`;
}

export function postingSummary(posting: Posting): string {
  return `Posting ${posting.postingId} ${posting.status} ${posting.amount.amountMinor} USD`;
}

export function sourceSummary(deliveryId: string, disposition: string): string {
  return `Source delivery ${deliveryId} ${disposition}`;
}

export function jobSummary(job: DurableJobMessage): string {
  return `Job ${job.jobId} ${job.jobType} ${job.state}`;
}

export function forecastSummary(snapshot: ForecastSnapshot): string {
  return `Forecast ${snapshot.forecastId} revision ${snapshot.revision} total ${snapshot.total.amountMinor} USD`;
}

export function requireRequest(ctx: HandlerContext, requestId: string): PurchaseRequestRevision {
  const request = currentRequestOf(ctx, requestId);
  if (!request) {
    throw new MockContractError("NOT_FOUND", `request ${requestId} is not known to ${ctx.company.organizationId}`);
  }
  return request;
}
export function currentRequestOf(ctx: HandlerContext, requestId: string): PurchaseRequestRevision | undefined {
  return ctx.company.requests.get(requestId)?.at(-1);
}

export function budgetOf(ctx: HandlerContext): BudgetAccount {
  const budget = ctx.company.budgetAccounts.get(ctx.company.registry.budgetAccountId);
  if (!budget) {
    throw new MockContractError("INTERNAL_ERROR", `budget account ${ctx.company.registry.budgetAccountId} is missing from mock state`);
  }
  return budget;
}

export function commitmentFor(ctx: HandlerContext, requestId: string): Commitment | undefined {
  return [...ctx.company.commitments.values()].find((commitment) => commitment.requestRef.id === requestId);
}

/** Budget availability is derived, never stored twice: authorized − recognized − outstanding. */
export function refreshBudget(budget: BudgetAccount): void {
  budget.available = {
    amountMinor: budget.authorized.amountMinor - budget.recognizedSpend.amountMinor - budget.outstandingCommitments.amountMinor,
    currency: "USD",
  };
  budget.revision += 1;
}

export function refreshCommitmentState(commitment: Commitment): void {
  const outstanding = commitment.outstandingAmount.amountMinor;
  commitment.state = outstanding === 0 ? "posted" : outstanding < commitment.amount.amountMinor ? "partially_posted" : "outstanding";
}

export function requestRefOf(request: PurchaseRequestRevision): RecordRef {
  return { type: "request", id: request.requestId, revision: request.revision };
}

/** Decisions are immutable in this mock, so their ref revision is always 1. */
export function decisionRefOf(decision: Decision): RecordRef {
  return { type: "decision", id: decision.decisionId, revision: 1 };
}

export function scopesIntersect(left: readonly ScopeRef[], right: readonly ScopeRef[]): boolean {
  return left.some((a) => right.some((b) => a.type === b.type && a.id === b.id));
}

export function provenanceFor(ctx: HandlerContext, sourceObjectId: string, trust: "authoritative" | "evidence" = "authoritative"): Provenance {
  return createProvenance(ctx.clock.now(), sourceObjectId, trust);
}
/** Fresh refs every call: stored records must never share a mutable object with pack data. */
export function policyRef(): RecordRef {
  return { type: "policy", id: SEEDED_POLICY_ID, revision: 1 };
}

export function evidenceRef(): RecordRef {
  return { type: "evidence", id: SEEDED_EVIDENCE_ID, revision: 1 };
}

function isRegisteredScope(ctx: HandlerContext, scope: ScopeRef): boolean {
  return ctx.company.registry.scopeRefs.some((known) => known.type === scope.type && known.id === scope.id);
}

/** Writes may only name references registered in the authenticated organization. */
export function assertRegisteredScopes(ctx: HandlerContext, scopes: readonly ScopeRef[]): void {
  const unknownRefs = scopes.filter((scope) => !isRegisteredScope(ctx, scope)).map((scope) => `${scope.type}:${scope.id}`);
  if (unknownRefs.length > 0) {
    throw new MockContractError("VALIDATION_FAILED", `unregistered scope references: ${unknownRefs.join(", ")}`, { unknownRefs });
  }
}

/** Reads treat a foreign scope as an authorization failure rather than a validation failure. */
export function assertAccessibleScopes(ctx: HandlerContext, scopes: readonly ScopeRef[]): void {
  const unknownRefs = scopes.filter((scope) => !isRegisteredScope(ctx, scope)).map((scope) => `${scope.type}:${scope.id}`);
  if (unknownRefs.length > 0) {
    throw new MockContractError("ACCESS_DENIED", `scopes outside ${ctx.company.organizationId}: ${unknownRefs.join(", ")}`, { unknownRefs });
  }
}

export function assertEntityRegistered(ctx: HandlerContext, type: "category" | "vendor" | "project" | "employee", id: string): void {
  const registry = ctx.company.registry;
  const known = type === "category"
    ? registry.categoryIds.includes(id)
    : type === "vendor"
      ? registry.vendorId === id
      : type === "project"
        ? registry.projectId === id
        : registry.employeeIds.includes(id);
  if (!known) {
    throw new MockContractError("VALIDATION_FAILED", `unregistered ${type} reference: ${id}`, { unknownRefs: [`${type}:${id}`] });
  }
}

export function assertNoExpectations(ctx: HandlerContext): void {
  const expected = ctx.meta.expectedVersions ?? [];
  if (expected.length > 0) {
    throw new MockContractError("VALIDATION_FAILED", "this command must not declare expected versions", { expectedVersions: expected });
  }
}

/** Requires exactly one expectation entry, for the named ref, and no others. */
export function requireExpectation(ctx: HandlerContext, ref: { type: string; id: string }): VersionExpectation {
  const expected = ctx.meta.expectedVersions ?? [];
  const matching = expected.filter((entry) => entry.ref.type === ref.type && entry.ref.id === ref.id);
  if (expected.length !== 1 || matching.length !== 1) {
    throw new MockContractError(
      "VALIDATION_FAILED",
      `expectedVersions must declare exactly one entry for ${ref.type} ${ref.id}`,
      { expectedVersions: expected, requiredRef: ref },
    );
  }
  return matching[0]!;
}

export function assertRevisionMatch(ref: { type: string; id: string }, expected: number, actual: number): void {
  if (expected !== actual) {
    throw new MockContractError(
      "STALE_VERSION",
      `${ref.type} ${ref.id} is at revision ${actual}, not ${expected}`,
      { expected, actual, ref },
    );
  }
}

export interface ActivityWrite {
  item: ActivityItem;
  scopeRefs: ScopeRef[];
}

export function appendActivity(ctx: HandlerContext, item: ActivityItem, scopeRefs: readonly ScopeRef[]): void {
  ctx.store.appendActivity(ctx.company.organizationId, item, [...scopeRefs]);
}
/** A hard cap that cannot absorb the reservation fails before any state changes. */
export function assertCapacity(budget: BudgetAccount, reserveDeltaMinor: number): void {
  if (budget.hardCap && reserveDeltaMinor > budget.available.amountMinor) {
    throw new MockContractError(
      "CAPACITY_EXCEEDED",
      `budget ${budget.budgetAccountId} cannot reserve ${reserveDeltaMinor} with ${budget.available.amountMinor} available`,
      { available: budget.available.amountMinor, required: reserveDeltaMinor },
    );
  }
}

/**
 * Sets the request's commitment to `amountMinor` and reserves the delta on the budget. Callers must
 * have passed `assertCapacity` first, so this is the only place commitment and budget move together.
 */
export function applyCommitmentReserve(ctx: HandlerContext, request: PurchaseRequestRevision, decision: Decision, amountMinor: number): Commitment {
  const budget = budgetOf(ctx);
  const existing = commitmentFor(ctx, request.requestId);
  const reserveDeltaMinor = amountMinor - (existing?.amount.amountMinor ?? 0);
  let commitment: Commitment;
  if (existing) {
    existing.requestRef = requestRefOf(request);
    existing.decisionRef = decisionRefOf(decision);
    existing.amount = usd(amountMinor);
    existing.outstandingAmount = usd(existing.outstandingAmount.amountMinor + reserveDeltaMinor);
    existing.revision += 1;
    commitment = existing;
  } else {
    commitment = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      organizationId: ctx.company.organizationId,
      commitmentId: ctx.ids.next("commitment"),
      revision: 1,
      requestRef: requestRefOf(request),
      decisionRef: decisionRefOf(decision),
      amount: usd(amountMinor),
      outstandingAmount: usd(amountMinor),
      state: "outstanding",
      budgetAccountRefs: [{ type: "budget_account", id: budget.budgetAccountId, revision: budget.revision }],
      createdAt: ctx.clock.now(),
    };
    ctx.company.commitments.set(commitment.commitmentId, commitment);
  }
  budget.outstandingCommitments = usd(budget.outstandingCommitments.amountMinor + reserveDeltaMinor);
  refreshBudget(budget);
  refreshCommitmentState(commitment);
  return commitment;
}
