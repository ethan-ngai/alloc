import type { BudgetAccount, PurchaseRequestRevision, RecordRef } from "@alloc/contracts";
import { FinancialRulesInputError } from "./errors.js";
import { assertNonNegativeUsd, assertUsdAmount, compareUsd, equalsUsd, subtractUsd, type UsdMoney } from "./money.js";
import { refOfBudget } from "./reason-codes.js";
import type { BindingBudgetInput, CumulativeLimitScope, CumulativeTotalInput } from "./types.js";

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Strict ISO 8601 parsing; a loose format or a non-instant is an invalid input, not a decision. */
export function parseTimestamp(value: unknown, path: string): number {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    throw new FinancialRulesInputError("INVALID_TIMESTAMP", path, "expected an ISO 8601 timestamp with an explicit offset");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new FinancialRulesInputError("INVALID_TIMESTAMP", path, "timestamp is not a real instant");
  return parsed;
}

export function requireRequesterRoles(roles: readonly string[] | undefined, path: string): string[] {
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new FinancialRulesInputError("MISSING_REQUIRED_INPUT", path, "expected at least one trusted requester role");
  }
  roles.forEach((role, index) => {
    if (typeof role !== "string" || role.length === 0) {
      throw new FinancialRulesInputError("MISSING_REQUIRED_INPUT", `${path}[${index}]`, "expected a non-empty role name");
    }
  });
  return [...roles];
}

export interface CheckedBudget {
  account: BudgetAccount;
  reserveDelta: UsdMoney;
  ref: RecordRef;
}

/**
 * Validates every binding budget and its reserve delta. The derived availability identity is
 * checked because policy must never authorize against a stale or contradictory cap snapshot.
 */
export function checkBudgets(budgets: readonly BindingBudgetInput[], request: PurchaseRequestRevision, evaluatedAtMs: number, path = "budgets"): CheckedBudget[] {
  return budgets.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const account = entry?.account;
    if (typeof account !== "object" || account === null) {
      throw new FinancialRulesInputError("MISSING_REQUIRED_INPUT", entryPath, "expected a budget account and reserve delta");
    }
    if (account.organizationId !== request.organizationId) {
      throw new FinancialRulesInputError("ORGANIZATION_MISMATCH", `${entryPath}.account.organizationId`, "budget account belongs to another organization");
    }
    const reserveDelta = assertNonNegativeUsd(entry.reserveDelta, `${entryPath}.reserveDelta`);
    const authorized = assertNonNegativeUsd(account.authorized, `${entryPath}.account.authorized`);
    const recognized = assertNonNegativeUsd(account.recognizedSpend, `${entryPath}.account.recognizedSpend`);
    const outstanding = assertNonNegativeUsd(account.outstandingCommitments, `${entryPath}.account.outstandingCommitments`);
    const available = assertUsdAmount(account.available, `${entryPath}.account.available`);
    const derived = subtractUsd(subtractUsd(authorized, recognized, entryPath), outstanding, entryPath);
    if (!equalsUsd(derived, available)) {
      throw new FinancialRulesInputError("INCONSISTENT_BUDGET", `${entryPath}.account.available`, `available ${available.amountMinor} does not equal authorized - recognized - outstanding (${derived.amountMinor})`);
    }
    const evaluatedOn = new Date(evaluatedAtMs).toISOString().slice(0, 10);
    if (evaluatedOn < account.periodStart || evaluatedOn > account.periodEnd) {
      throw new FinancialRulesInputError("BUDGET_PERIOD_MISMATCH", `${entryPath}.account`, `budget period ${account.periodStart}..${account.periodEnd} does not contain ${evaluatedOn}`);
    }
    return { account, reserveDelta, ref: refOfBudget(account) };
  });
}

/** The identity a dimension total is keyed on for the revision under evaluation. */
export function ownDimensionId(dimension: CumulativeLimitScope, request: PurchaseRequestRevision): string | null {
  if (dimension === "employee") return request.requesterId;
  if (dimension === "purpose") return request.purpose;
  return request.projectId ?? null;
}

/**
 * Validates cumulative totals, rejects duplicate dimension keys, and refuses a total that sits
 * below the revision's own cumulative increase. That check is what stops a caller from resetting
 * previously consumed allowance by omitting or understating a dimension.
 */
export function checkCumulativeTotals(totals: readonly CumulativeTotalInput[], request: PurchaseRequestRevision, path = "cumulativeTotals"): CumulativeTotalInput[] {
  const seen = new Set<string>();
  return totals.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const dimension = entry?.dimension;
    if (dimension !== "employee" && dimension !== "purpose" && dimension !== "project") {
      throw new FinancialRulesInputError("MISSING_REQUIRED_INPUT", `${entryPath}.dimension`, "expected employee, purpose, or project");
    }
    if (typeof entry.dimensionId !== "string" || entry.dimensionId.length === 0) {
      throw new FinancialRulesInputError("MISSING_REQUIRED_INPUT", `${entryPath}.dimensionId`, "expected a non-empty dimension identity");
    }
    const key = `${dimension}\u0000${entry.dimensionId}`;
    if (seen.has(key)) {
      throw new FinancialRulesInputError("DUPLICATE_CUMULATIVE_DIMENSION", entryPath, `duplicate ${dimension} total for ${entry.dimensionId}`);
    }
    seen.add(key);
    const cumulativeIncrease = assertNonNegativeUsd(entry.cumulativeIncrease, `${entryPath}.cumulativeIncrease`);
    if (!Array.isArray(entry.sources) || entry.sources.length === 0) {
      throw new FinancialRulesInputError("MISSING_REQUIRED_INPUT", `${entryPath}.sources`, "expected at least one factual source reference");
    }
    entry.sources.forEach((source, sourceIndex) => {
      if (typeof source?.type !== "string" || source.type.length === 0 || typeof source.id !== "string" || source.id.length === 0) {
        throw new FinancialRulesInputError("MISSING_REQUIRED_INPUT", `${entryPath}.sources[${sourceIndex}]`, "expected a typed record reference");
      }
    });
    const ownId = ownDimensionId(dimension, request);
    if (ownId !== null && ownId === entry.dimensionId && compareUsd(cumulativeIncrease, request.cumulativeIncrease) < 0) {
      throw new FinancialRulesInputError("INCONSISTENT_CUMULATIVE_TOTAL", `${entryPath}.cumulativeIncrease`, "dimension total is below the evaluated revision's own cumulative increase");
    }
    return { ...entry, cumulativeIncrease, sources: [...entry.sources] };
  });
}
