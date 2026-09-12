/**
 * Deterministic mock evaluation, used only to drive UI states (approved / review_required / denied).
 * This is NOT the 3A rules engine and never validates policy: it is a fixture evaluator whose
 * reason codes reuse the frozen 1A vocabulary so the frontend can render the same states the real
 * engine will report. First matching rule wins.
 */
export interface PolicyConstants {
  autoApproveMaxFullAmount: number;
  cumulativeIncreaseMax: number;
  hardDenyFullAmount: number;
}

export const DEFAULT_POLICY_CONSTANTS: PolicyConstants = Object.freeze({
  autoApproveMaxFullAmount: 25_000,
  cumulativeIncreaseMax: 5_000,
  hardDenyFullAmount: 100_000,
});

export type PolicyOutcome = "approved" | "review_required" | "denied";

export interface PolicyEvaluation {
  outcome: PolicyOutcome;
  reasonCodes: string[];
}

export interface PolicyInput {
  fullAmountMinor: number;
  cumulativeIncreaseMinor: number;
  reserveDeltaMinor: number;
  availableMinor: number;
  hardCap: boolean;
  constants?: PolicyConstants;
}

export const HUMAN_REVIEW_APPROVED_REASON = "AUTHORIZED_HUMAN_EXCEPTION";
export const HUMAN_REVIEW_DENIED_REASON = "HUMAN_REVIEW_DENIED";

export function evaluateMockPolicy(input: PolicyInput): PolicyEvaluation {
  const constants = input.constants ?? DEFAULT_POLICY_CONSTANTS;
  if (input.fullAmountMinor > constants.hardDenyFullAmount) {
    return { outcome: "denied", reasonCodes: ["FULL_AMOUNT_EXCEEDS_HARD_LIMIT"] };
  }
  if (input.fullAmountMinor > constants.autoApproveMaxFullAmount) {
    return { outcome: "review_required", reasonCodes: ["FULL_AMOUNT_EXCEEDS_AUTO_LIMIT"] };
  }
  if (input.cumulativeIncreaseMinor > constants.cumulativeIncreaseMax) {
    return { outcome: "review_required", reasonCodes: ["CUMULATIVE_INCREASE_LIMIT_EXCEEDED"] };
  }
  if (input.hardCap && input.reserveDeltaMinor > input.availableMinor) {
    return { outcome: "review_required", reasonCodes: ["BUDGET_CAPACITY_INSUFFICIENT"] };
  }
  return { outcome: "approved", reasonCodes: ["WITHIN_AUTO_APPROVAL_LIMITS"] };
}
