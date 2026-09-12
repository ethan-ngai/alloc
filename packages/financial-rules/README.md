# `@alloc/financial-rules`

Task 3A's pure, deterministic financial policy evaluation. It consumes the frozen [1A contracts](../contracts), performs checked USD minor-unit arithmetic, derives increase-only amendments, and returns approved / review_required / denied decisions plus approval-grant verdicts. There is no MongoDB, HTTP, model, clock, randomness, ID, or timestamp dependency: every input is an explicit trusted fact and every output is a pure function of those facts.

## Limits

- **Pure only.** The package persists nothing and generates no identities or times. Its results carry the facts they were derived from; the transactional layer (3B) owns decisions, commitments, postings, and caps.
- **Trusted-input boundary.** The caller resolves tenancy, access, requester roles, purpose state, cumulative totals, eligible evidence, approver authority, and the binding budget set. This package proves those inputs are internally consistent; it cannot prove they came from the authoritative store.
- **One contract line.** Amendments are increase-only. Reductions are rejected rather than modeled, so a revision cannot silently reset consumed allowance.
- **Fixture-level evidence.** 3B (#8) owns MongoDB concurrency, atomic multi-record updates, and the HTTP acceptance flow.

## Commands

The package is a workspace member of the repository root, so install and build once from there:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build                                    # builds @alloc/contracts first
npm run typecheck --workspace @alloc/financial-rules
npm test --workspace @alloc/financial-rules
```

The build matters even for tests: `@alloc/contracts` resolves through its `dist` output.

## Public API

| Export | Purpose |
| --- | --- |
| `usd`, `addUsd`, `subtractUsd`, `sumUsd`, `compareUsd`, `equalsUsd`, `maxUsd`, `isZeroUsd` | Checked USD minor-unit arithmetic with safe-integer overflow detection |
| `assertUsdAmount`, `assertNonNegativeUsd`, `assertPositiveUsd`, `assertSafeMinor` | Money validation that rejects non-integers, unsafe integers, and non-USD currency |
| `deriveAmendment`, `deriveAmendmentIncrease` | Increase-only amendment derivation with monotonic cumulative increase |
| `evaluateRequestPolicy(input)` | Deterministic decision for one request revision, optionally lifting a review with a grant |
| `validateApprovalGrant(input)` | Grant binding and current human authority verdict |
| `REASON_CODE`, `ReasonCode` | Stable reason-code vocabulary (reuses frozen 1A/2A fixture and 2C mock codes) |
| `FinancialRulesInputError`, `FINANCIAL_RULES_ERROR_CODES` | Explicit invalid-input errors carrying `code`, `path`, and message |
| `PolicyEvaluationInput`, `PolicyEvaluationResult`, `ApprovalGrantValidationInput`, `ApprovalGrantValidationResult`, `BindingBudgetInput`, `CumulativeTotalInput`, `TrustedPurposeState`, `ApproverAuthority`, `GrantContext`, `CumulativeLimitScope` | Typed inputs and results |

## Evaluation model

**Precedence.** `deny` > `require_review` > `permit`. An applicable `deny` rule or an exhausted hard cap denies. A matching `require_review` rule, a failed mandatory check, missing coverage, missing trusted facts, stale or missing evidence, an exceeded automatic limit, or an over-drawn soft cap requires review. Automatic approval needs full permit coverage and every check passing, and returns `WITHIN_CUMULATIVE_ALLOWANCE`. A valid grant converts a review into `AUTHORIZED_HUMAN_EXCEPTION`; it never overrides a denial.

**Windows are half-open.** A policy is active when `effectiveFrom <= evaluatedAt < effectiveTo`, with `null` meaning no end. Grant validity is the same shape over `grantedAt` and `expiresAt`.

**Dimensions.** A rule that sets `maximumCumulativeIncrease` compares against the cumulative total for its `cumulativeLimitScope` — `employee` (keyed by requester), `purpose` (keyed by the request's purpose; the default when omitted), or `project` (keyed by project). Totals are authoritative inputs that include the evaluated revision and must cite at least one source. A total for the request's own dimension that sits below that revision's own cumulative increase is rejected as inconsistent rather than treated as a reset.

**Evidence.** Required kinds are matched against eligible evidence for the same organization; with `maximumEvidenceAgeSeconds` set, freshness is measured from `provenance.observedAt` and future-observed evidence counts as stale.

**Budgets.** Every supplied budget is checked: the caller supplies the reservation delta (normally the revision's increase from the previous revision), availability must equal `authorized - recognizedSpend - outstandingCommitments`, and the account period must contain the evaluation instant. A hard cap that cannot absorb the delta denies a request and invalidates a grant; a soft cap that cannot absorb it requires review.

**Grants.** Organization, typed request reference and revision, exact USD amount, action type, typed policy reference and revision, authorization epoch, granted/expires window, current approver identity, role, and scope, separation of duties, and hard-cap capacity must all still hold. An organization-scoped authority covers every scope inside that organization. Any changed or revoked binding reports a stable `GRANT_*` reason code and leaves the request in review. Because decisions and grants carry one required role, simultaneously matching rules with conflicting approver roles are rejected as inconsistent policy instead of depending on rule order.

## Verification

`npm test` runs 127 tests: checked arithmetic and overflow, increase-only amendment derivation against the frozen 1A amendment records, the policy threshold/date/scope/role/vendor/evidence/fact/cap tables including ±1 minor-unit boundaries, the grant-binding mismatch matrix, and the deterministic 1A/2A Northstar replay of $180 → $210 → $240 → finance-manager approval with exact outcomes and references. This is pure fixture-level evidence; it is not a MongoDB, HTTP, provider, model, or hardware pass.
