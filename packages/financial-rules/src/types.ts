import type {
  ApprovalGrant, BudgetAccount, Decision, Evidence, Policy, PolicyRule, PurchaseRequestRevision,
  RecordRef, ScopeRef,
} from "@alloc/contracts";
import type { ReasonCode } from "./reason-codes.js";
import type { UsdMoney } from "./money.js";

export type PolicyOutcome = Decision["outcome"];
export type ApprovalActionType = ApprovalGrant["actionType"];
export type CumulativeLimitScope = NonNullable<PolicyRule["cumulativeLimitScope"]>;

/** Dimension a cumulative allowance is measured over when a rule omits `cumulativeLimitScope`. */
export const DEFAULT_CUMULATIVE_LIMIT_SCOPE: CumulativeLimitScope = "purpose";

/** Trusted, backend-resolved purpose state. `purpose` is the identity the dimension totals key on. */
export interface TrustedPurposeState {
  purpose: string;
  active: boolean;
  ref?: RecordRef;
}

/**
 * Authoritative cumulative increase already consumed for one dimension, including the revision
 * under evaluation. `sources` are the facts the total was derived from and are echoed into the
 * evaluation result.
 */
export interface CumulativeTotalInput {
  dimension: CumulativeLimitScope;
  dimensionId: string;
  cumulativeIncrease: UsdMoney;
  sources: readonly RecordRef[];
}

/** One binding budget account plus the non-negative amount this evaluation would reserve. */
export interface BindingBudgetInput {
  account: BudgetAccount;
  reserveDelta: UsdMoney;
}

/** Current, backend-resolved approver authority. `revoked` invalidates every bound grant. */
export interface ApproverAuthority {
  organizationId: string;
  approverId: string;
  roles: readonly string[];
  scopes: readonly ScopeRef[];
  revoked?: boolean;
}

export interface GrantContext {
  grant: ApprovalGrant;
  approver: ApproverAuthority;
}

export interface PolicyEvaluationInput {
  /** Evaluation instant; policy and grant validity are half-open around it. */
  evaluatedAt: string;
  /** Complete request revision under evaluation. */
  request: PurchaseRequestRevision;
  /** Active policy revision. A non-effective or out-of-scope policy cannot permit. */
  policy: Policy;
  /** Trusted roles held by the requester at evaluation time. */
  requesterRoles: readonly string[];
  /** Trusted purpose state, or `null` when the caller has no trusted fact for this purpose. */
  purpose: TrustedPurposeState | null;
  /** Cumulative totals for every dimension the evaluation may need. */
  cumulativeTotals: readonly CumulativeTotalInput[];
  /** Evidence eligible for this evaluation; access, tenancy, and retention are the caller's job. */
  evidence: readonly Evidence[];
  /** Every budget account this approval would bind, with its reservation delta. */
  budgets: readonly BindingBudgetInput[];
  /** Supplied when the request already requires review and a human has decided. */
  grant?: GrantContext;
}

/**
 * Deterministic evaluation result. It mirrors the contract `Decision` fields except identity and
 * time, which the persisting layer generates. `approvalGrantRef` carries no revision because the
 * wire grant has none; grants are immutable and addressed by ID.
 */
export interface PolicyEvaluationResult {
  outcome: PolicyOutcome;
  reasonCodes: ReasonCode[];
  matchedRuleIds: string[];
  policyRef: RecordRef;
  authorizationEpoch: number;
  evaluatedFullAmount: UsdMoney;
  evaluatedCumulativeIncrease: UsdMoney;
  factualInputs: RecordRef[];
  evidenceRefs: RecordRef[];
  requiredApproverRole: string | null;
  approvalGrantRef?: RecordRef;
  permittedAction: { type: "simulate_purchase"; amount: UsdMoney } | null;
}

export interface ApprovalGrantValidationInput {
  evaluatedAt: string;
  grant: ApprovalGrant;
  request: PurchaseRequestRevision;
  policy: Policy;
  requesterRoles: readonly string[];
  approver: ApproverAuthority;
  /** Exact action the approver authorized. */
  actionType: ApprovalActionType;
  /** Exact amount the approver authorized. */
  amount: UsdMoney;
  /** Current binding budgets; when supplied, a hard cap that cannot absorb the delta fails. */
  budgets?: readonly BindingBudgetInput[];
}

export interface ApprovalGrantValidationResult {
  valid: boolean;
  reasonCodes: ReasonCode[];
  grantRef: RecordRef;
  requiredApproverRole: string | null;
}
