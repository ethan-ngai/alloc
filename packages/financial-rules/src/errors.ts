/**
 * Explicit invalid-input errors. Policy *outcomes* never throw; malformed or contradictory trusted
 * inputs do, because a caller that passes them cannot be answered with a safe decision.
 */
export const FINANCIAL_RULES_ERROR_CODES = [
  "CURRENCY_MISMATCH",
  "MALFORMED_AMOUNT",
  "UNSAFE_INTEGER",
  "NEGATIVE_AMOUNT",
  "NON_POSITIVE_AMOUNT",
  "INVALID_TIMESTAMP",
  "MISSING_REQUIRED_INPUT",
  "ORGANIZATION_MISMATCH",
  "INCONSISTENT_BUDGET",
  "BUDGET_PERIOD_MISMATCH",
  "INCONSISTENT_CUMULATIVE_TOTAL",
  "DUPLICATE_CUMULATIVE_DIMENSION",
  "INCONSISTENT_APPROVER_ROLE",
  "AMENDMENT_NOT_AN_INCREASE",
  "REVISION_CHAIN_INVALID",
] as const;

export type FinancialRulesErrorCode = (typeof FINANCIAL_RULES_ERROR_CODES)[number];

export class FinancialRulesInputError extends Error {
  readonly code: FinancialRulesErrorCode;
  readonly path: string;

  constructor(code: FinancialRulesErrorCode, path: string, detail: string) {
    super(`${code} at ${path}: ${detail}`);
    this.name = "FinancialRulesInputError";
    this.code = code;
    this.path = path;
  }
}
