import { BudgetAccountSchema, type BudgetAccount, type Posting, type PurchaseRequestRevision, type ScopeRef } from "@alloc/contracts";
import { usd, type UsdMoney } from "@alloc/financial-rules";
import type { ClientSession, Db } from "mongodb";
import { BUDGETS_COLLECTION } from "./collections.js";
import { financeErrors } from "./errors.js";

export function scopeKey(scope: ScopeRef): string {
  return `${scope.type}\u0000${scope.id}`;
}

/** Every scope a request can bind, including the dimension scopes a policy may cap. */
export function requestBudgetScopes(request: PurchaseRequestRevision): ScopeRef[] {
  const scopes: ScopeRef[] = [...request.scopes];
  scopes.push({ type: "category", id: request.categoryId });
  scopes.push({ type: "employee", id: request.requesterId });
  if (request.vendorId !== undefined) scopes.push({ type: "vendor", id: request.vendorId });
  if (request.projectId !== undefined) scopes.push({ type: "project", id: request.projectId });
  return dedupeScopes(scopes);
}

export function postingBudgetScopes(posting: Posting): ScopeRef[] {
  return dedupeScopes([...posting.scopes, { type: "organization", id: posting.organizationId }]);
}

function dedupeScopes(scopes: readonly ScopeRef[]): ScopeRef[] {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const key = scopeKey(scope);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function utcDate(timestamp: string): string {
  return new Date(Date.parse(timestamp)).toISOString().slice(0, 10);
}

/**
 * Resolves every budget account bound by the given scopes whose accounting
 * period contains the effective date. Ordering is by account ID so concurrent
 * transactions acquire the same documents in the same order.
 */
export async function resolveBindingBudgets(
  db: Db,
  organizationId: string,
  scopes: readonly ScopeRef[],
  effectiveAt: string,
  session: ClientSession,
): Promise<BudgetAccount[]> {
  const unique = dedupeScopes(scopes);
  if (unique.length === 0) {
    return [];
  }
  const effectiveDate = utcDate(effectiveAt);
  const documents = await db
    .collection(BUDGETS_COLLECTION)
    .find(
      { organizationId, $or: unique.map((scope) => ({ "scope.type": scope.type, "scope.id": scope.id })) },
      { session, projection: { _id: 0 } },
    )
    .toArray();
  return documents
    .map((document) => BudgetAccountSchema.parse(document))
    .filter((account) => effectiveDate >= account.periodStart && effectiveDate <= account.periodEnd)
    .sort((left, right) => (left.budgetAccountId < right.budgetAccountId ? -1 : left.budgetAccountId > right.budgetAccountId ? 1 : 0));
}

export interface ExposureDelta {
  recognized: number;
  outstanding: number;
}

/**
 * Applies one exposure delta to every binding account with a revision-conditional
 * write. A concurrent change fails the write instead of overwriting it, so the
 * caller's transaction retries against fresh state.
 */
export async function applyExposure(
  db: Db,
  accounts: readonly BudgetAccount[],
  delta: ExposureDelta,
  options: { enforceHardCap: boolean },
  session: ClientSession,
): Promise<BudgetAccount[]> {
  const updated: BudgetAccount[] = [];
  for (const account of accounts) {
    const recognized = usd(account.recognizedSpend.amountMinor + delta.recognized);
    const outstanding = usd(account.outstandingCommitments.amountMinor + delta.outstanding);
    if (outstanding.amountMinor < 0) {
      throw financeErrors.staleVersion(`budget ${account.budgetAccountId} would hold a negative commitment`);
    }
    if (recognized.amountMinor < 0) {
      throw financeErrors.validationFailed("recognized spend may never become negative", {
        reasonCode: "RECOGNIZED_SPEND_NEGATIVE",
        budgetAccountId: account.budgetAccountId,
      });
    }
    const available: UsdMoney = usd(
      account.authorized.amountMinor - recognized.amountMinor - outstanding.amountMinor,
    );
    if (options.enforceHardCap && account.hardCap && available.amountMinor < 0) {
      throw financeErrors.capacityExceeded(`hard cap ${account.budgetAccountId} cannot absorb the reservation`, {
        reasonCode: "HARD_CAP_CAPACITY_INSUFFICIENT",
        budgetAccountId: account.budgetAccountId,
        availableMinor: available.amountMinor,
      });
    }
    const result = await db.collection(BUDGETS_COLLECTION).updateOne(
      { organizationId: account.organizationId, budgetAccountId: account.budgetAccountId, revision: account.revision },
      { $set: { recognizedSpend: recognized, outstandingCommitments: outstanding, available, revision: account.revision + 1 } },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw financeErrors.staleVersion(`budget ${account.budgetAccountId} changed during the transaction`);
    }
    updated.push({
      ...account,
      recognizedSpend: recognized,
      outstandingCommitments: outstanding,
      available,
      revision: account.revision + 1,
    });
  }
  return updated;
}

export function budgetRefOf(account: BudgetAccount): { type: string; id: string; revision: number } {
  return { type: "budget_account", id: account.budgetAccountId, revision: account.revision };
}
