import { CONTRACT_SCHEMA_VERSION } from "@alloc/contracts";
import type { Evidence, MemoryFact, ScopeRef } from "../contract-types.js";
import { MockContractError } from "../errors.js";
import { usd } from "../money.js";
import { createProvenance } from "../packs.js";
import { assertAccessibleScopes, commitmentFor, currentRequestOf, paginate, scopesIntersect } from "./context.js";
import type { Handler, HandlerContext } from "./context.js";

function organizationRequested(ctx: HandlerContext, requested: readonly ScopeRef[]): boolean {
  return requested.some((scope) => scope.type === "organization" && scope.id === ctx.company.organizationId);
}

/** Requesting the organization scope widens visibility: every fact in that organization matches. */
function factVisible(ctx: HandlerContext, scopeRefs: readonly ScopeRef[], requested: readonly ScopeRef[]): boolean {
  return organizationRequested(ctx, requested) || scopesIntersect(scopeRefs, requested);
}

/**
 * Facts are derived from live state rather than authored: budget position, the current request
 * revision, commitment outstanding, and the pack's identity labels.
 */
function collectFacts(ctx: HandlerContext): MemoryFact[] {
  const identity = ctx.company.pack.identity;
  const registry = ctx.company.registry;
  const seed = ctx.company.seededAt;
  const tenant = registry.tenantScope;
  const department: ScopeRef = { type: "department", id: identity.department.id };
  const facts: MemoryFact[] = [
    {
      ref: { type: "organization", id: identity.organizationId, revision: 1 },
      label: "Organization display name",
      value: identity.displayName,
      scopeRefs: [tenant],
      provenance: createProvenance(seed, "seed-organization"),
    },
    {
      ref: { type: "department", id: identity.department.id, revision: 1 },
      label: "Department name",
      value: identity.department.name,
      scopeRefs: [tenant, department],
      provenance: createProvenance(seed, "seed-department"),
    },
    ...(identity.project === null ? [] : [{
      ref: { type: "project" as const, id: identity.project.id, revision: 1 },
      label: "Project name",
      value: identity.project.name,
      scopeRefs: [tenant, department, { type: "project" as const, id: identity.project.id }],
      provenance: createProvenance(seed, "seed-project"),
    }]),
    ...identity.categories.map((category) => ({
      ref: { type: "category" as const, id: category.id, revision: 1 },
      label: `${category.name} category`,
      value: category.name,
      scopeRefs: [tenant, { type: "category" as const, id: category.id }],
      provenance: createProvenance(seed, `seed-category-${category.id}`),
    })),
    {
      ref: { type: "vendor", id: identity.vendor.id, revision: 1 },
      label: `${identity.vendor.name} vendor`,
      value: identity.vendor.name,
      scopeRefs: [tenant, { type: "vendor", id: identity.vendor.id }],
      provenance: createProvenance(seed, `seed-vendor-${identity.vendor.id}`),
    },
  ];

  const budget = ctx.company.budgetAccounts.get(registry.budgetAccountId);
  if (budget) {
    const budgetScopes: ScopeRef[] = [tenant, { type: "account", id: budget.budgetAccountId }, budget.scope];
    const budgetRef = { type: "budget_account", id: budget.budgetAccountId, revision: budget.revision };
    const amounts: Array<{ label: string; amountMinor: number }> = [
      { label: "Budget authorized amount", amountMinor: budget.authorized.amountMinor },
      { label: "Budget recognized spend", amountMinor: budget.recognizedSpend.amountMinor },
      { label: "Budget outstanding commitments", amountMinor: budget.outstandingCommitments.amountMinor },
      { label: "Budget available amount", amountMinor: budget.available.amountMinor },
    ];
    for (const entry of amounts) {
      facts.push({
        ref: budgetRef,
        label: entry.label,
        value: usd(entry.amountMinor),
        scopeRefs: budgetScopes,
        provenance: createProvenance(seed, `budget-account-${budget.budgetAccountId}`),
      });
    }
  }

  for (const requestId of ctx.company.requests.keys()) {
    const request = currentRequestOf(ctx, requestId);
    if (!request) continue;
    facts.push({
      ref: { type: "request", id: request.requestId, revision: request.revision },
      label: "Current request full amount",
      value: usd(request.fullAmount.amountMinor),
      scopeRefs: request.scopes,
      provenance: structuredClone(request.provenance),
    });
    const commitment = commitmentFor(ctx, requestId);
    if (commitment) {
      facts.push({
        ref: { type: "commitment", id: commitment.commitmentId, revision: commitment.revision },
        label: "Commitment outstanding amount",
        value: usd(commitment.outstandingAmount.amountMinor),
        scopeRefs: request.scopes,
        provenance: createProvenance(commitment.createdAt, `commitment-${commitment.commitmentId}`),
      });
    }
  }
  return facts;
}

export const queryMemory: Handler<"memory.query"> = (ctx, payload) => {
  assertAccessibleScopes(ctx, payload.scopes);
  const now = ctx.clock.now();
  const asOf = payload.asOf ?? now;
  if (Date.parse(asOf) > Date.parse(now)) {
    throw new MockContractError("VALIDATION_FAILED", `asOf ${asOf} is later than the mock clock ${now}`, {
      reasonCode: "asOfInFuture",
      asOf,
      clock: now,
    });
  }

  const needle = payload.query.toLowerCase();
  const facts = collectFacts(ctx).filter((fact) => (
    (fact.label.toLowerCase().includes(needle) || fact.scopeRefs.some((scope) => scope.id.toLowerCase().includes(needle)))
    && factVisible(ctx, fact.scopeRefs, payload.scopes)
    && Date.parse(fact.provenance.occurredAt) <= Date.parse(asOf)
  ));
  const page = paginate(facts, payload.page);
  const evidence: Evidence[] = factVisible(ctx, ctx.company.pack.evidence.access.scopeRefs, payload.scopes)
    ? [structuredClone(ctx.company.pack.evidence)]
    : [];
  const requestRevisionCount = [...ctx.company.requests.values()].reduce((total, revisions) => total + revisions.length, 0);

  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: ctx.company.organizationId,
    queryId: ctx.ids.next("query"),
    asOf,
    facts: page.items,
    evidence,
    assumptions: [],
    missingFields: facts.length === 0 ? ["facts"] : [],
    sourceWatermarks: {
      mock_scenario: ctx.company.pack.identity.scenarioId,
      mock_clock: now,
      mock_request_count: String(requestRevisionCount),
    },
    page: page.page,
  };
};
