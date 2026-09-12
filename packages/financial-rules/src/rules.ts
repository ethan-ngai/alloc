import type { Evidence, Policy, PolicyRule, PurchaseRequestRevision, RecordRef } from "@alloc/contracts";
import { parseTimestamp, ownDimensionId } from "./inputs.js";
import { compareUsd, type UsdMoney } from "./money.js";
import { REASON_CODE, refOfEvidence, type ReasonCode } from "./reason-codes.js";
import { DEFAULT_CUMULATIVE_LIMIT_SCOPE, type CumulativeLimitScope, type CumulativeTotalInput, type TrustedPurposeState } from "./types.js";

export interface RuleContext {
  request: PurchaseRequestRevision;
  evaluatedAtMs: number;
  purpose: TrustedPurposeState | null;
  cumulativeTotals: readonly CumulativeTotalInput[];
  evidence: readonly Evidence[];
}

export interface RuleEvaluation {
  rule: PolicyRule;
  failures: ReasonCode[];
  evidenceRefs: RecordRef[];
  cumulativeUsed: UsdMoney | null;
}

/**
 * Half-open policy validity: `effectiveFrom <= evaluatedAt < effectiveTo`, with `null` meaning no
 * end. A policy that is not yet effective, has expired, or does not cover the request scope cannot
 * permit anything.
 */
export function policyApplicability(policy: Policy, request: PurchaseRequestRevision, evaluatedAtMs: number): ReasonCode[] {
  const failures: ReasonCode[] = [];
  const effectiveFromMs = parseTimestamp(policy.effectiveFrom, "policy.effectiveFrom");
  if (evaluatedAtMs < effectiveFromMs) failures.push(REASON_CODE.POLICY_NOT_YET_EFFECTIVE);
  if (policy.effectiveTo !== null && evaluatedAtMs >= parseTimestamp(policy.effectiveTo, "policy.effectiveTo")) failures.push(REASON_CODE.POLICY_EXPIRED);
  if (!policyScopeCovers(policy, request)) failures.push(REASON_CODE.POLICY_SCOPE_MISMATCH);
  return failures;
}

function policyScopeCovers(policy: Policy, request: PurchaseRequestRevision): boolean {
  const scope = policy.scope;
  if (scope.type === "organization") return scope.id === request.organizationId;
  return request.scopes.some(item => item.type === scope.type && item.id === scope.id);
}

export function matchesCategory(rule: PolicyRule, request: PurchaseRequestRevision): boolean {
  return rule.categoryIds.includes(request.categoryId);
}

export function matchesRequesterRole(rule: PolicyRule, requesterRoles: readonly string[]): boolean {
  return rule.requesterRoles.some(role => requesterRoles.includes(role));
}

/** Evaluates one structurally matching rule's own eligibility conditions. */
export function evaluateRule(rule: PolicyRule, context: RuleContext): RuleEvaluation {
  const failures: ReasonCode[] = [];
  const evidenceRefs: RecordRef[] = [];
  let cumulativeUsed: UsdMoney | null = null;

  const eligibleVendorIds = rule.eligibleVendorIds;
  if (eligibleVendorIds) {
    const vendorId = context.request.vendorId;
    if (vendorId === undefined || !eligibleVendorIds.includes(vendorId)) failures.push(REASON_CODE.VENDOR_NOT_ELIGIBLE);
  }

  if (rule.requireActivePurpose) {
    if (context.purpose === null || context.purpose.purpose !== context.request.purpose) failures.push(REASON_CODE.MISSING_TRUSTED_FACTS);
    else if (!context.purpose.active) failures.push(REASON_CODE.PURPOSE_NOT_ACTIVE);
  }

  if (rule.requiredEvidenceKinds.length > 0) {
    const selection = selectEvidence(rule.requiredEvidenceKinds, rule.maximumEvidenceAgeSeconds, context);
    evidenceRefs.push(...selection.refs);
    if (selection.missing) failures.push(REASON_CODE.EVIDENCE_MISSING);
    if (selection.stale) failures.push(REASON_CODE.EVIDENCE_STALE);
  }

  const maximumFullAmount = rule.maximumFullAmount;
  if (maximumFullAmount && compareUsd(context.request.fullAmount, maximumFullAmount) > 0) {
    failures.push(REASON_CODE.FULL_AMOUNT_EXCEEDS_AUTO_LIMIT);
  }

  const maximumCumulativeIncrease = rule.maximumCumulativeIncrease;
  if (maximumCumulativeIncrease) {
    const dimension = rule.cumulativeLimitScope ?? DEFAULT_CUMULATIVE_LIMIT_SCOPE;
    const total = findCumulativeTotal(context, dimension);
    if (total === null) {
      failures.push(REASON_CODE.MISSING_TRUSTED_FACTS);
    } else {
      cumulativeUsed = total.cumulativeIncrease;
      if (compareUsd(total.cumulativeIncrease, maximumCumulativeIncrease) > 0) failures.push(REASON_CODE.CUMULATIVE_INCREASE_LIMIT_EXCEEDED);
    }
  }

  return { rule, failures, evidenceRefs, cumulativeUsed };
}

export function findCumulativeTotal(context: RuleContext, dimension: CumulativeLimitScope): CumulativeTotalInput | null {
  const dimensionId = ownDimensionId(dimension, context.request);
  if (dimensionId === null) return null;
  return context.cumulativeTotals.find(total => total.dimension === dimension && total.dimensionId === dimensionId) ?? null;
}

function selectEvidence(kinds: readonly string[], maximumAgeSeconds: number | undefined, context: RuleContext): { refs: RecordRef[]; missing: boolean; stale: boolean } {
  const refs: RecordRef[] = [];
  let missing = false;
  let stale = false;
  for (const kind of kinds) {
    const candidates = context.evidence.filter(item => item.kind === kind && item.organizationId === context.request.organizationId);
    if (candidates.length === 0) {
      missing = true;
      continue;
    }
    const fresh = candidates.filter(item => isFresh(item, maximumAgeSeconds, context.evaluatedAtMs));
    if (fresh.length === 0) {
      stale = true;
      continue;
    }
    refs.push(...fresh.map(refOfEvidence));
  }
  return { refs, missing, stale };
}

/** Freshness is measured from observation, not the source document's own timestamp. */
function isFresh(evidence: Evidence, maximumAgeSeconds: number | undefined, evaluatedAtMs: number): boolean {
  if (maximumAgeSeconds === undefined) return true;
  const observedAtMs = Date.parse(evidence.provenance.observedAt);
  if (!Number.isFinite(observedAtMs)) return false;
  const ageSeconds = (evaluatedAtMs - observedAtMs) / 1000;
  return ageSeconds >= 0 && ageSeconds <= maximumAgeSeconds;
}
