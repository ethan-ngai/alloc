import { CONTRACT_SCHEMA_VERSION, type Provenance, type PurchaseRequestRevision, type RequestAmendment } from "@alloc/contracts";
import { FinancialRulesInputError } from "./errors.js";
import { parseTimestamp } from "./inputs.js";
import { addUsd, assertNonNegativeUsd, assertPositiveUsd, subtractUsd, type MoneyInput, type UsdMoney } from "./money.js";

export interface DeriveAmendmentInput {
  /** Revision the amendment starts from; supplies the request, organization, and prior amounts. */
  previous: PurchaseRequestRevision;
  revisedFullAmount: MoneyInput;
  /** Resolved identity and evidence supplied by the caller; this package generates neither. */
  amendmentId: string;
  reason: string;
  submittedBy: string;
  submittedAt: string;
  provenance: Provenance;
}

/**
 * Increase-only amendment derivation for this contract line. The revised amount must strictly
 * exceed the previous amount, and the cumulative increase is the previous cumulative increase plus
 * the new increase, so a reduction can never reset previously consumed allowance.
 */
export function deriveAmendmentIncrease(previousFullAmount: MoneyInput, revisedFullAmount: MoneyInput, path = "revisedFullAmount"): UsdMoney {
  const previous = assertPositiveUsd(previousFullAmount, "previousFullAmount");
  const revised = assertPositiveUsd(revisedFullAmount, path);
  const increase = subtractUsd(revised, previous, path);
  if (increase.amountMinor <= 0) {
    throw new FinancialRulesInputError("AMENDMENT_NOT_AN_INCREASE", path, "this contract line supports increase-only amendments");
  }
  return increase;
}

export function deriveAmendment(input: DeriveAmendmentInput): RequestAmendment {
  const previous = input.previous;
  if (typeof previous !== "object" || previous === null) {
    throw new FinancialRulesInputError("MISSING_REQUIRED_INPUT", "previous", "expected the revision being amended");
  }
  for (const [path, value] of [["amendmentId", input.amendmentId], ["reason", input.reason], ["submittedBy", input.submittedBy]] as const) {
    if (typeof value !== "string" || value.length === 0) throw new FinancialRulesInputError("MISSING_REQUIRED_INPUT", path, "expected a non-empty string");
  }
  parseTimestamp(input.submittedAt, "submittedAt");
  const increase = deriveAmendmentIncrease(previous.fullAmount, input.revisedFullAmount);
  const cumulativeIncrease = addUsd(assertNonNegativeUsd(previous.cumulativeIncrease, "previous.cumulativeIncrease"), increase, "cumulativeIncrease");
  const toRevision = previous.revision + 1;
  if (!Number.isSafeInteger(toRevision)) throw new FinancialRulesInputError("REVISION_CHAIN_INVALID", "previous.revision", "revision overflow");
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: previous.organizationId,
    amendmentId: input.amendmentId,
    requestId: previous.requestId,
    fromRevision: previous.revision,
    toRevision,
    previousFullAmount: previous.fullAmount,
    revisedFullAmount: assertPositiveUsd(input.revisedFullAmount, "revisedFullAmount"),
    increase,
    cumulativeIncrease,
    reason: input.reason,
    submittedBy: input.submittedBy,
    submittedAt: input.submittedAt,
    provenance: input.provenance,
  };
}
