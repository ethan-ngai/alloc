import { FinancialRulesInputError } from "./errors.js";

/** Exact USD money in minor units. */
export interface UsdMoney {
  amountMinor: number;
  currency: "USD";
}

/** Caller-supplied money whose currency is not trusted until it is checked. */
export interface MoneyInput {
  amountMinor: number;
  currency: string;
}

export const CONTRACT_CURRENCY = "USD" as const;

export function usd(amountMinor: number): UsdMoney {
  assertSafeMinor(amountMinor, "amountMinor");
  return { amountMinor, currency: CONTRACT_CURRENCY };
}

/** Rejects non-integers, values outside the safe integer range, and non-numbers. */
export function assertSafeMinor(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new FinancialRulesInputError("MALFORMED_AMOUNT", path, "expected an integer minor-unit amount");
  }
  if (!Number.isSafeInteger(value)) {
    throw new FinancialRulesInputError("UNSAFE_INTEGER", path, "minor-unit amount exceeds the safe integer range");
  }
  return value;
}

/** Validates shape, currency, and safe-integer range; returns the checked value. */
export function assertUsdAmount(value: unknown, path: string): UsdMoney {
  if (typeof value !== "object" || value === null) {
    throw new FinancialRulesInputError("MALFORMED_AMOUNT", path, "expected a money object");
  }
  const candidate = value as { amountMinor?: unknown; currency?: unknown };
  const amountMinor = assertSafeMinor(candidate.amountMinor, `${path}.amountMinor`);
  if (candidate.currency !== CONTRACT_CURRENCY) {
    throw new FinancialRulesInputError("CURRENCY_MISMATCH", `${path}.currency`, `expected ${CONTRACT_CURRENCY}, received ${String(candidate.currency)}`);
  }
  return { amountMinor, currency: CONTRACT_CURRENCY };
}

export function assertNonNegativeUsd(value: unknown, path: string): UsdMoney {
  const money = assertUsdAmount(value, path);
  if (money.amountMinor < 0) throw new FinancialRulesInputError("NEGATIVE_AMOUNT", path, "expected a non-negative amount");
  return money;
}

export function assertPositiveUsd(value: unknown, path: string): UsdMoney {
  const money = assertUsdAmount(value, path);
  if (money.amountMinor <= 0) throw new FinancialRulesInputError("NON_POSITIVE_AMOUNT", path, "expected a positive amount");
  return money;
}

export function addUsd(left: UsdMoney, right: UsdMoney, path = "amount"): UsdMoney {
  const sum = left.amountMinor + right.amountMinor;
  if (!Number.isSafeInteger(sum)) throw new FinancialRulesInputError("UNSAFE_INTEGER", path, "addition exceeded the safe integer range");
  return { amountMinor: sum, currency: CONTRACT_CURRENCY };
}

export function sumUsd(amounts: readonly UsdMoney[], path = "amounts"): UsdMoney {
  const total = amounts.reduce((sum, amount) => sum + amount.amountMinor, 0);
  if (!Number.isSafeInteger(total)) throw new FinancialRulesInputError("UNSAFE_INTEGER", path, "summation exceeded the safe integer range");
  return { amountMinor: total, currency: CONTRACT_CURRENCY };
}

export function subtractUsd(left: UsdMoney, right: UsdMoney, path = "amount"): UsdMoney {
  const difference = left.amountMinor - right.amountMinor;
  if (!Number.isSafeInteger(difference)) throw new FinancialRulesInputError("UNSAFE_INTEGER", path, "subtraction exceeded the safe integer range");
  return { amountMinor: difference, currency: CONTRACT_CURRENCY };
}

export function compareUsd(left: UsdMoney, right: UsdMoney): -1 | 0 | 1 {
  if (left.amountMinor < right.amountMinor) return -1;
  return left.amountMinor > right.amountMinor ? 1 : 0;
}

export function equalsUsd(left: UsdMoney, right: UsdMoney): boolean {
  return left.amountMinor === right.amountMinor;
}

export function maxUsd(left: UsdMoney, right: UsdMoney): UsdMoney {
  return compareUsd(left, right) >= 0 ? left : right;
}

export function isZeroUsd(value: UsdMoney): boolean {
  return value.amountMinor === 0;
}
