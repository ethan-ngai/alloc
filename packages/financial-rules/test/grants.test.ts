import { describe, expect, it } from "vitest";
import { REASON_CODE, usd, validateApprovalGrant } from "../src/index.js";
import type { ApprovalGrantValidationInput, ReasonCode, UsdMoney } from "../src/index.js";
import { REQUESTER_ID, approvalGrant, approverAuthority, budget, clean, policy, request, requestReference, rule } from "./harness.js";
import type { Mutable } from "./harness.js";
import { errorCode, errorMessage } from "./harness.js";

const EVALUATED_AT = "2026-09-12T14:16:00Z";
const cappedBudget = (available: number, reserveDelta: number, hardCap = true) => [{ account: budget({ hardCap, authorized: usd(available), recognizedSpend: usd(0), outstandingCommitments: usd(0) }), reserveDelta: usd(reserveDelta) }];

const baseInput = (overrides: Mutable<ApprovalGrantValidationInput> = {}): ApprovalGrantValidationInput => clean({
  evaluatedAt: EVALUATED_AT,
  grant: approvalGrant(),
  request: request(),
  policy: policy(),
  requesterRoles: ["employee"],
  approver: approverAuthority(),
  actionType: "approve_amendment",
  amount: usd(21_000),
  ...overrides,
}) as ApprovalGrantValidationInput;

const cases: Array<[string, Mutable<ApprovalGrantValidationInput>, ReasonCode[]]> = [
  ["accepts a grant that binds the current revision and authority", {}, []],
  ["accepts a grant at the exact instant it is effective", { evaluatedAt: "2026-09-12T14:15:00Z" }, []],
  ["rejects a grant from another organization", { grant: approvalGrant({ organizationId: "org_other_tenant" }) }, [REASON_CODE.GRANT_ORGANIZATION_MISMATCH]],
  ["rejects an approver from another organization", { approver: approverAuthority({ organizationId: "org_other_tenant" }) }, [REASON_CODE.GRANT_ORGANIZATION_MISMATCH]],
  ["rejects a grant bound to another request", { grant: approvalGrant({ requestRef: { type: "request", id: "request_other_trip", revision: 2 } }) }, [REASON_CODE.GRANT_REQUEST_MISMATCH]],
  ["rejects a request reference with the wrong record type", { grant: approvalGrant({ requestRef: { type: "policy", id: "request_buffalo_trip", revision: 2 } }) }, [REASON_CODE.GRANT_REQUEST_MISMATCH]],
  ["rejects a grant bound to an older revision", { grant: approvalGrant({ requestRef: requestReference(1) }) }, [REASON_CODE.GRANT_REVISION_MISMATCH]],
  ["rejects a grant that authorizes a different amount", { amount: usd(21_001) }, [REASON_CODE.GRANT_AMOUNT_MISMATCH]],
  ["rejects a grant whose exact amount differs", { grant: approvalGrant({ exactAmount: usd(20_000) }) }, [REASON_CODE.GRANT_AMOUNT_MISMATCH]],
  ["rejects a grant for another action type", { actionType: "approve_request" }, [REASON_CODE.GRANT_ACTION_MISMATCH]],
  ["rejects a grant bound to another policy revision", { grant: approvalGrant({ policyRef: { type: "policy", id: "policy_travel", revision: 2 } }) }, [REASON_CODE.GRANT_POLICY_MISMATCH]],
  ["rejects a policy reference with the wrong record type", { grant: approvalGrant({ policyRef: { type: "request", id: "policy_travel", revision: 1 } }) }, [REASON_CODE.GRANT_POLICY_MISMATCH]],
  ["rejects a grant whose policy has expired", { policy: policy({ effectiveTo: "2026-09-12T14:00:00Z" }) }, [REASON_CODE.GRANT_POLICY_MISMATCH]],
  ["rejects a grant whose policy is not yet effective", { policy: policy({ effectiveFrom: "2026-09-12T15:00:00Z" }) }, [REASON_CODE.GRANT_POLICY_MISMATCH]],
  ["rejects a grant from a previous authorization epoch", { grant: approvalGrant({ authorizationEpoch: 2 }) }, [REASON_CODE.GRANT_EPOCH_MISMATCH]],
  ["rejects a grant used before it was granted", { evaluatedAt: "2026-09-12T14:14:59Z" }, [REASON_CODE.GRANT_NOT_YET_EFFECTIVE]],
  ["expires a grant at its exclusive end", { evaluatedAt: "2026-09-12T14:45:00Z" }, [REASON_CODE.GRANT_EXPIRED]],
  ["rejects a revoked approver", { approver: approverAuthority({ revoked: true }) }, [REASON_CODE.GRANT_AUTHORITY_REVOKED]],
  ["rejects a grant naming another approver", { approver: approverAuthority({ approverId: "employee_other_finance" }) }, [REASON_CODE.GRANT_APPROVER_IDENTITY_MISMATCH]],
  ["rejects a role the policy does not authorize", { grant: approvalGrant({ authorityRole: "employee" }) }, [REASON_CODE.GRANT_APPROVER_ROLE_MISMATCH]],
  ["rejects a revoked role", { approver: approverAuthority({ roles: ["engineer"] }) }, [REASON_CODE.GRANT_APPROVER_ROLE_MISMATCH]],
  ["rejects an approver without scope over the granted scope", { approver: approverAuthority({ scopes: [{ type: "project", id: "project_atlas" }] }) }, [REASON_CODE.GRANT_APPROVER_SCOPE_MISMATCH]],
  ["rejects a granted scope outside the request", { grant: approvalGrant({ scope: { type: "vendor", id: "vendor_buffalo_hotel" } }) }, [REASON_CODE.GRANT_SCOPE_MISMATCH]],
  ["rejects requester self-approval when the policy prohibits it", {
    policy: policy({ rules: [rule({ requiredApproverRole: undefined })] }),
    grant: approvalGrant({ approverId: REQUESTER_ID, authorityRole: "employee" }),
    approver: approverAuthority({ approverId: REQUESTER_ID, roles: ["employee"] }),
  }, [REASON_CODE.GRANT_SELF_APPROVAL_PROHIBITED]],
  ["rejects a grant whose hard cap is exhausted", { budgets: cappedBudget(3_000, 3_001) }, [REASON_CODE.GRANT_HARD_CAP_EXHAUSTED]],
  ["accepts a grant with capacity exactly at the hard cap", { budgets: cappedBudget(3_000, 3_000) }, []],
  ["accepts a grant when a soft cap is overdrawn", { budgets: cappedBudget(3_000, 3_001, false) }, []],
  ["reports every mismatch deterministically", { evaluatedAt: "2026-09-12T14:45:00Z", grant: approvalGrant({ requestRef: requestReference(1) }) }, [REASON_CODE.GRANT_EXPIRED, REASON_CODE.GRANT_REVISION_MISMATCH]],
];

describe("validateApprovalGrant", () => {
  it.each(cases)("%s", (_name, overrides, reasonCodes) => {
    const result = validateApprovalGrant(baseInput(overrides));
    expect(result.reasonCodes).toEqual(reasonCodes);
    expect(result.valid).toBe(reasonCodes.length === 0);
  });

  it("returns the grant reference and required approver role without inventing a revision", () => {
    const result = validateApprovalGrant(baseInput());
    expect(Object.keys(result).sort()).toEqual(["grantRef", "reasonCodes", "requiredApproverRole", "valid"]);
    expect(result.grantRef).toEqual({ type: "approval_grant", id: "grant_finance_review" });
    expect(result.requiredApproverRole).toBe("finance_manager");
  });

  it("is deterministic for identical inputs", () => {
    const input = baseInput({ evaluatedAt: "2026-09-12T14:20:00Z" });
    expect(validateApprovalGrant(input)).toEqual(validateApprovalGrant(input));
  });

  it("rejects malformed grant and authority inputs", () => {
    expect(errorCode(() => validateApprovalGrant(baseInput({ evaluatedAt: "2026-09-12" })))).toBe("INVALID_TIMESTAMP");
    expect(errorMessage(() => validateApprovalGrant(baseInput({ evaluatedAt: "2026-09-12" })))).toContain("at evaluatedAt:");
    expect(errorCode(() => validateApprovalGrant(baseInput({ grant: approvalGrant({ grantedAt: "12 September 2026" }) })))).toBe("INVALID_TIMESTAMP");
    expect(errorCode(() => validateApprovalGrant(baseInput({ amount: { amountMinor: 21_000, currency: "EUR" } as unknown as UsdMoney })))).toBe("CURRENCY_MISMATCH");
    expect(errorCode(() => validateApprovalGrant(baseInput({ amount: usd(2 ** 53) })))).toBe("UNSAFE_INTEGER");
    expect(errorCode(() => validateApprovalGrant(baseInput({ amount: usd(0) })))).toBe("NON_POSITIVE_AMOUNT");
    expect(errorCode(() => validateApprovalGrant(baseInput({ policy: policy({ organizationId: "org_other_tenant" }) })))).toBe("ORGANIZATION_MISMATCH");
    expect(errorCode(() => validateApprovalGrant(baseInput({ requesterRoles: [] })))).toBe("MISSING_REQUIRED_INPUT");
    expect(errorCode(() => validateApprovalGrant(baseInput({ budgets: [{ account: budget({ available: usd(1) }), reserveDelta: usd(3_000) }] })))).toBe("INCONSISTENT_BUDGET");
    expect(errorCode(() => validateApprovalGrant(baseInput({ budgets: [{ account: budget({ organizationId: "org_other_tenant" }), reserveDelta: usd(3_000) }] })))).toBe("ORGANIZATION_MISMATCH");
    expect(errorCode(() => validateApprovalGrant(baseInput({ grant: approvalGrant({ exactAmount: { amountMinor: 21_000, currency: "EUR" } as unknown as UsdMoney }) })))).toBe("CURRENCY_MISMATCH");
  });

  it("rejects conflicting approver roles independently of rule order", () => {
    const financeRule = rule({ ruleId: "rule_finance", requiredApproverRole: "finance_manager" });
    const controllerRule = rule({ ruleId: "rule_controller", effect: "require_review", requiredApproverRole: "controller" });
    for (const rules of [[financeRule, controllerRule], [controllerRule, financeRule]]) {
      expect(errorCode(() => validateApprovalGrant(baseInput({ policy: policy({ rules }) })))).toBe("INCONSISTENT_APPROVER_ROLE");
    }
  });
});
