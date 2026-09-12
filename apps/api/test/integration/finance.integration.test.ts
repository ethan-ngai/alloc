import {
  BudgetAccountSchema, CommitmentSchema, CompanyEntitySchema, EvidenceSchema, PolicySchema, PostingCorrectionSchema, PostingSchema, SourceDeliverySchema,
  type BudgetAccount, type Commitment, type Policy, type Posting, type ScopeRef,
} from "@alloc/contracts";
import { startMongoReplicaSet, type MongoTestCluster } from "@alloc/test-support";
import { usd } from "@alloc/financial-rules";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUDIT_EVENTS_COLLECTION, COMMANDS_COLLECTION, COMMITMENTS_COLLECTION, REQUEST_CURRENT_COLLECTION, REQUEST_REVISIONS_COLLECTION,
} from "../../src/finance/collections.js";
import { recordId } from "../../src/finance/ids.js";
import type { FinancialContext } from "../../src/finance/internal.js";
import { MongoFinancialRepository, type FinancialRepository } from "../../src/finance/repository.js";
import { connectMongoRuntime, type MongoRuntime } from "../../src/mongo/runtime.js";
import { loadNorthstarFixture, northstarSeed } from "../support/finance.js";

const FIXED = new Date("2026-09-12T14:00:00.000Z");
const FIXED_NOW = FIXED.toISOString();
const FINANCE_MANAGER_ROLE = "finance_manager";
const CATEGORY = "category_travel";
const EMPLOYEE = "employee_maya_chen";
const FINANCE = "employee_avery_finance";

interface Harness {
  readonly cluster: MongoTestCluster;
  readonly runtime: MongoRuntime;
  readonly finance: FinancialRepository;
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.runtime.close().catch(() => undefined);
  await harness?.cluster.stop();
  harness = undefined;
});

async function open(): Promise<Harness> {
  const cluster = await startMongoReplicaSet({ label: "finance" });
  const runtime = await connectMongoRuntime({ uri: cluster.uri, database: cluster.database });
  harness = { cluster, runtime, finance: new MongoFinancialRepository(runtime.db, runtime.withTransaction, () => FIXED) };
  return harness;
}

function employeeContext(organizationId: string): FinancialContext {
  return { principalId: EMPLOYEE, organizationId, roles: ["employee"] };
}

function financeContext(organizationId: string): FinancialContext {
  return { principalId: FINANCE, organizationId, roles: ["finance_manager"] };
}

function authoritySeed(organizationId: string, revokeEmployee = false, revokeFinance = false) {
  return [
    {
      principalId: EMPLOYEE, roles: ["employee"],
      scopes: [{ type: "organization", id: organizationId }] satisfies ScopeRef[], revoked: revokeEmployee,
    },
    {
      principalId: FINANCE, roles: ["finance_manager"],
      scopes: [{ type: "organization", id: organizationId }] satisfies ScopeRef[], revoked: revokeFinance,
    },
  ];
}

function simplePolicy(organizationId: string, overrides: Record<string, unknown> = {}): Policy {
  return PolicySchema.parse({
    schemaVersion: "1.0.0",
    organizationId,
    policyId: "policy_spend",
    revision: 1,
    authorizationEpoch: 1,
    name: "Test spending policy",
    scope: { type: "organization", id: organizationId },
    effectiveFrom: "2026-06-01T00:00:00.000Z",
    effectiveTo: null,
    rules: [{
      ruleId: "rule_spend", effect: "permit", categoryIds: [CATEGORY], requesterRoles: ["employee"],
      maximumFullAmount: { amountMinor: 25_000, currency: "USD" }, requireActivePurpose: false,
      requiredEvidenceKinds: [], ...overrides,
    }],
    publishedBy: FINANCE,
  });
}

function budgetAccount(organizationId: string, budgetAccountId: string, scope: ScopeRef, authorizedMinor: number): BudgetAccount {
  return BudgetAccountSchema.parse({
    schemaVersion: "1.0.0", organizationId, budgetAccountId, revision: 1, scope,
    authorized: usd(authorizedMinor), recognizedSpend: usd(0), outstandingCommitments: usd(0),
    available: usd(authorizedMinor), hardCap: true, periodStart: "2026-06-01", periodEnd: "2027-06-30",
  });
}

function createInput(organizationId: string, commandId: string, fullAmountMinor: number, purpose = "test purpose") {
  return {
    meta: { schemaVersion: "1.0.0" as const, organizationId, commandId, correlationId: `correlation_${commandId}`, expectedVersions: [] },
    payload: {
      requesterId: EMPLOYEE,
      purpose,
      fullAmount: usd(fullAmountMinor),
      categoryId: CATEGORY,
      vendorId: "vendor_buffalo_hotel",
      scopes: [{ type: "organization" as const, id: organizationId }],
    },
  };
}

function amendInput(organizationId: string, commandId: string, requestId: string, expectedRevision: number, revisedFullAmountMinor: number) {
  return {
    meta: {
      schemaVersion: "1.0.0" as const, organizationId, commandId, correlationId: `correlation_${commandId}`,
      expectedVersions: [{ ref: { type: "request", id: requestId }, expectedRevision }],
    },
    payload: { requestId, revisedFullAmount: usd(revisedFullAmountMinor), reason: "Additional lodging" },
  };
}

function reviewInput(organizationId: string, commandId: string, requestId: string, requestRevision: number, outcome: "approved" | "denied") {
  return {
    meta: {
      schemaVersion: "1.0.0" as const, organizationId, commandId, correlationId: `correlation_${commandId}`,
      expectedVersions: [{ ref: { type: "request", id: requestId }, expectedRevision: requestRevision }],
    },
    payload: { requestId, requestRevision, outcome, rationale: "Reviewed against policy" },
  };
}

function postingInput(organizationId: string, posting: Posting, commandId: string) {
  const { organizationId: _organizationId, schemaVersion: _schemaVersion, ...payload } = posting;
  return {
    meta: { schemaVersion: "1.0.0" as const, organizationId, commandId, correlationId: `correlation_${commandId}`, expectedVersions: [] },
    payload,
  };
}

function correctionInput(organizationId: string, correction: ReturnType<typeof PostingCorrectionSchema.parse>, commandId: string) {
  const { organizationId: _organizationId, schemaVersion: _schemaVersion, ...payload } = correction;
  return {
    meta: { schemaVersion: "1.0.0" as const, organizationId, commandId, correlationId: `correlation_${commandId}`, expectedVersions: [] },
    payload,
  };
}

function postingFixture(organizationId: string, postingId: string, amountMinor: number, commitment?: Commitment): Posting {
  return PostingSchema.parse({
    schemaVersion: "1.0.0", organizationId, postingId, revision: 1, amount: usd(amountMinor),
    occurredAt: FIXED_NOW, status: "posted",
    ...(commitment ? { commitmentRef: { type: "commitment", id: commitment.commitmentId, revision: commitment.revision } } : {}),
    sourceRef: { type: "action_receipt", id: "receipt_test", revision: 1 },
    scopes: [{ type: "organization", id: organizationId }, { type: "category", id: CATEGORY }],
    provenance: {
      kind: "synthetic", trust: "authoritative", sourceInstanceId: "source_api_command",
      sourceObjectId: postingId, sourceRevision: "1", occurredAt: FIXED_NOW, observedAt: FIXED_NOW,
    },
  });
}

function evidenceFixture(organizationId: string, evidenceId: string, scopeRefs: ScopeRef[]) {
  return EvidenceSchema.parse({
    schemaVersion: "1.0.0", organizationId, evidenceId, revision: 1, kind: "document_excerpt",
    title: "Scoped supporting document", content: "Synthetic evidence for a policy requirement.",
    access: { classification: "internal", scopeRefs, allowedPrincipalIds: [] },
    provenance: {
      kind: "synthetic", trust: "evidence", sourceInstanceId: "source_api_command",
      sourceObjectId: evidenceId, sourceRevision: "1", occurredAt: FIXED_NOW, observedAt: FIXED_NOW,
    },
    authoritativeFor: [],
  });
}

describe("financial core against a real replica set", () => {
  it("admits exactly ten of forty concurrent $30 approvals against a $300 hard cap", async () => {
    const { runtime, finance } = await open();
    const organizationId = "org_cap";
    await finance.seed(organizationId, {
      policies: [simplePolicy(organizationId)],
      budgets: [budgetAccount(organizationId, "budget_cap", { type: "organization", id: organizationId }, 30_000)],
      authorities: authoritySeed(organizationId),
    });

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) => finance.createRequest(
        employeeContext(organizationId), createInput(organizationId, `command_cap_${index}`, 3_000),
      )),
    );
    const approved = results.filter((request) => request.evaluationState === "approved");
    const denied = results.filter((request) => request.evaluationState === "denied");
    expect(approved).toHaveLength(10);
    expect(denied).toHaveLength(30);

    const budget = await finance.getBudgetAccount(organizationId, "budget_cap");
    expect(budget?.outstandingCommitments.amountMinor).toBe(30_000);
    expect(budget?.available.amountMinor).toBe(0);
    expect(await runtime.db.collection(COMMITMENTS_COLLECTION).countDocuments({ organizationId })).toBe(10);
  });

  it("updates hierarchical caps together and serializes competing approvals", async () => {
    const { finance } = await open();
    const organizationId = "org_hierarchical";
    await finance.seed(organizationId, {
      policies: [simplePolicy(organizationId)],
      budgets: [
        budgetAccount(organizationId, "budget_company", { type: "organization", id: organizationId }, 100_000),
        budgetAccount(organizationId, "budget_category", { type: "category", id: CATEGORY }, 6_000),
      ],
      authorities: authoritySeed(organizationId),
    });

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) => finance.createRequest(
        employeeContext(organizationId), createInput(organizationId, `command_hier_${index}`, 3_000),
      )),
    );
    expect(results.filter((request) => request.evaluationState === "approved")).toHaveLength(2);
    expect((await finance.getBudgetAccount(organizationId, "budget_category"))?.outstandingCommitments.amountMinor).toBe(6_000);
    expect((await finance.getBudgetAccount(organizationId, "budget_company"))?.outstandingCommitments.amountMinor).toBe(6_000);
  });

  it("commits one of two parallel amendments of the same revision and reports the other stale", async () => {
    const { finance } = await open();
    const organizationId = "org_amend";
    await finance.seed(organizationId, {
      policies: [simplePolicy(organizationId)],
      budgets: [budgetAccount(organizationId, "budget_amend", { type: "organization", id: organizationId }, 100_000)],
      authorities: authoritySeed(organizationId),
    });
    const created = await finance.createRequest(employeeContext(organizationId), createInput(organizationId, "command_amend_create", 18_000));

    const settled = await Promise.allSettled([
      finance.amendRequest(employeeContext(organizationId), amendInput(organizationId, "command_amend_a", created.requestId, 1, 21_000)),
      finance.amendRequest(employeeContext(organizationId), amendInput(organizationId, "command_amend_b", created.requestId, 1, 21_000)),
    ]);
    expect(settled.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((outcome) => outcome.status === "rejected");
    expect(rejected && (rejected as PromiseRejectedResult).reason).toMatchObject({ code: "STALE_VERSION" });

    const view = await finance.getRequest(organizationId, created.requestId);
    expect(view?.request.revision).toBe(2);
    expect((await finance.listRequestRevisions(organizationId, created.requestId))).toHaveLength(2);
    expect(view?.commitment?.outstandingAmount.amountMinor).toBe(21_000);
  });

  it("rolls back requests, budgets, commitments, decisions, intents, commands, and audit on injected failure", async () => {
    const { runtime, finance } = await open();
    const organizationId = "org_rollback";
    await finance.seed(organizationId, {
      policies: [simplePolicy(organizationId)],
      budgets: [budgetAccount(organizationId, "budget_rollback", { type: "organization", id: organizationId }, 30_000)],
      authorities: authoritySeed(organizationId),
    });
    const commandId = "command_rollback";
    const requestId = recordId("request", organizationId, commandId);
    // A pre-existing commitment with the ID the command will derive makes the later insert
    // conflict after the budget write, proving the whole transaction rolls back.
    await runtime.db.collection(COMMITMENTS_COLLECTION).insertOne({ ...CommitmentSchema.parse({
      schemaVersion: "1.0.0", organizationId, commitmentId: recordId("commitment", organizationId, requestId), revision: 1,
      requestRef: { type: "request", id: "request_other", revision: 1 },
      decisionRef: { type: "decision", id: "decision_conflict", revision: 1 },
      amount: usd(3_000), outstandingAmount: usd(3_000), state: "outstanding",
      budgetAccountRefs: [{ type: "budget_account", id: "budget_rollback", revision: 1 }], createdAt: FIXED_NOW,
    }) });

    await expect(finance.createRequest(employeeContext(organizationId), createInput(organizationId, commandId, 3_000)))
      .rejects.toMatchObject({ code: 11000 });

    expect((await finance.getBudgetAccount(organizationId, "budget_rollback"))?.revision).toBe(1);
    expect((await finance.getBudgetAccount(organizationId, "budget_rollback"))?.outstandingCommitments.amountMinor).toBe(0);
    expect(await runtime.db.collection(REQUEST_REVISIONS_COLLECTION).countDocuments({ organizationId })).toBe(0);
    expect(await runtime.db.collection(REQUEST_CURRENT_COLLECTION).countDocuments({ organizationId })).toBe(0);
    expect(await runtime.db.collection(COMMANDS_COLLECTION).countDocuments({ organizationId })).toBe(0);
    expect(await finance.listAuditEvents(organizationId, requestId)).toHaveLength(0);
  });

  it("runs concurrent identical commands once and rejects changed reuse", async () => {
    const { finance } = await open();
    const organizationId = "org_idempotency";
    await finance.seed(organizationId, {
      policies: [simplePolicy(organizationId)],
      budgets: [budgetAccount(organizationId, "budget_idem", { type: "organization", id: organizationId }, 100_000)],
      authorities: authoritySeed(organizationId),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => finance.createRequest(employeeContext(organizationId), createInput(organizationId, "command_idem_create", 3_000))),
    );
    const requestIds = new Set(results.map((request) => request.requestId));
    expect(requestIds.size).toBe(1);
    const requestId = [...requestIds][0]!;
    expect((await finance.getBudgetAccount(organizationId, "budget_idem"))?.outstandingCommitments.amountMinor).toBe(3_000);
    expect((await finance.listRequestRevisions(organizationId, requestId))).toHaveLength(1);
    expect((await finance.listActionIntents(organizationId, requestId))).toHaveLength(1);

    await expect(finance.createRequest(employeeContext(organizationId), createInput(organizationId, "command_idem_create", 4_000)))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("does not memoize failed commands", async () => {
    const { finance } = await open();
    const organizationId = "org_retry";
    await finance.seed(organizationId, {
      policies: [simplePolicy(organizationId)],
      budgets: [budgetAccount(organizationId, "budget_retry", { type: "organization", id: organizationId }, 100_000)],
      authorities: authoritySeed(organizationId),
    });
    const created = await finance.createRequest(employeeContext(organizationId), createInput(organizationId, "command_retry_create", 18_000));

    await expect(finance.amendRequest(employeeContext(organizationId), amendInput(organizationId, "command_retry_amend", created.requestId, 99, 21_000)))
      .rejects.toMatchObject({ code: "STALE_VERSION" });
    const retried = await finance.amendRequest(employeeContext(organizationId), amendInput(organizationId, "command_retry_amend", created.requestId, 1, 21_000));
    expect(retried.request.revision).toBe(2);
  });

  it("invalidates a stale approval after authority revocation and after capacity loss", async () => {
    const { finance } = await open();
    const organizationId = "org_review";
    await finance.seed(organizationId, {
      policies: [simplePolicy(organizationId, { maximumCumulativeIncrease: usd(5_000), cumulativeLimitScope: "purpose", requiredApproverRole: FINANCE_MANAGER_ROLE, prohibitRequesterApproval: true })],
      budgets: [budgetAccount(organizationId, "budget_review", { type: "organization", id: organizationId }, 25_000)],
      authorities: authoritySeed(organizationId),
    });
    const created = await finance.createRequest(employeeContext(organizationId), createInput(organizationId, "command_review_create", 18_000));
    await finance.amendRequest(employeeContext(organizationId), amendInput(organizationId, "command_review_amend1", created.requestId, 1, 21_000));
    const reviewed = await finance.amendRequest(employeeContext(organizationId), amendInput(organizationId, "command_review_amend2", created.requestId, 2, 24_000));
    expect(reviewed.request.evaluationState).toBe("review_required");
    expect(reviewed.decision.reasonCodes).toContain("CUMULATIVE_INCREASE_LIMIT_EXCEEDED");

    await finance.seed(organizationId, { authorities: authoritySeed(organizationId, false, true) });
    await expect(finance.decideReview(financeContext(organizationId), reviewInput(organizationId, "command_review_denied_authority", created.requestId, 3, "approved")))
      .rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
    expect(await finance.listApprovalGrants(organizationId, created.requestId)).toHaveLength(0);

    await finance.seed(organizationId, { authorities: authoritySeed(organizationId) });
    const capacity = await finance.createRequest(employeeContext(organizationId), createInput(organizationId, "command_review_capacity", 4_000, "other purpose"));
    expect(capacity.evaluationState).toBe("approved");
    await expect(finance.decideReview(financeContext(organizationId), reviewInput(organizationId, "command_review_late", created.requestId, 3, "approved")))
      .rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(await finance.listApprovalGrants(organizationId, created.requestId)).toHaveLength(0);
  });

  it("preserves exposure on a matched posting, records overspend, tolerates duplicates, and compensates corrections", async () => {
    const { finance } = await open();
    const organizationId = "org_posting";
    await finance.seed(organizationId, {
      policies: [simplePolicy(organizationId)],
      budgets: [budgetAccount(organizationId, "budget_posting", { type: "organization", id: organizationId }, 100_000)],
      authorities: authoritySeed(organizationId),
    });
    const created = await finance.createRequest(employeeContext(organizationId), createInput(organizationId, "command_posting_create", 21_000));
    const commitment = await finance.getCommitment(organizationId, created.requestId);
    expect(commitment?.outstandingAmount.amountMinor).toBe(21_000);

    const matched = postingFixture(organizationId, "posting_matched", 21_000, commitment!);
    await finance.recordPosting(financeContext(organizationId), postingInput(organizationId, matched, "command_posting_matched"));
    let budget = await finance.getBudgetAccount(organizationId, "budget_posting");
    expect(budget?.recognizedSpend.amountMinor).toBe(21_000);
    expect(budget?.outstandingCommitments.amountMinor).toBe(0);
    expect(budget?.available.amountMinor).toBe(100_000 - 21_000);
    expect((await finance.getCommitment(organizationId, created.requestId))?.state).toBe("posted");
    // Matched posting moved the whole amount from commitment to spend: total exposure is unchanged.
    expect((budget?.recognizedSpend.amountMinor ?? 0) + (budget?.outstandingCommitments.amountMinor ?? 0)).toBe(21_000);
    await finance.recordPosting(financeContext(organizationId), postingInput(organizationId, matched, "command_posting_duplicate_a"));
    await finance.recordPosting(financeContext(organizationId), postingInput(organizationId, matched, "command_posting_duplicate_b"));
    budget = await finance.getBudgetAccount(organizationId, "budget_posting");
    expect(budget?.recognizedSpend.amountMinor).toBe(21_000);

    const unmatched = postingFixture(organizationId, "posting_unmatched", 5_000);
    await finance.recordPosting(financeContext(organizationId), postingInput(organizationId, unmatched, "command_posting_unmatched"));
    budget = await finance.getBudgetAccount(organizationId, "budget_posting");
    expect(budget?.recognizedSpend.amountMinor).toBe(26_000);
    expect(budget?.available.amountMinor).toBe(100_000 - 26_000);

    const correction = PostingCorrectionSchema.parse({
      schemaVersion: "1.0.0", organizationId, correctionId: "correction_unmatched", amount: usd(-5_000),
      originalPostingRef: { type: "posting", id: "posting_unmatched", revision: 1 }, reason: "Duplicated charge", occurredAt: FIXED_NOW,
      provenance: { kind: "synthetic", trust: "authoritative", sourceInstanceId: "source_api_command", sourceObjectId: "correction-1", sourceRevision: "1", occurredAt: FIXED_NOW, observedAt: FIXED_NOW },
    });
    await finance.correctPosting(financeContext(organizationId), correctionInput(organizationId, correction, "command_correction"));
    budget = await finance.getBudgetAccount(organizationId, "budget_posting");
    expect(budget?.recognizedSpend.amountMinor).toBe(21_000);

    const excessive = PostingCorrectionSchema.parse({ ...correction, correctionId: "correction_excessive", amount: usd(-999_000) });
    await expect(finance.correctPosting(financeContext(organizationId), correctionInput(organizationId, excessive, "command_correction_excessive")))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await finance.getBudgetAccount(organizationId, "budget_posting"))?.recognizedSpend.amountMinor).toBe(21_000);
  });

  it("keeps other tenants' records and capacity out of reach", async () => {
    const { finance } = await open();
    const organizationId = "org_isolation_a";
    const other = "org_isolation_b";
    await finance.seed(organizationId, {
      policies: [simplePolicy(organizationId)],
      budgets: [budgetAccount(organizationId, "budget_a", { type: "organization", id: organizationId }, 100_000)],
      authorities: authoritySeed(organizationId),
    });
    await finance.seed(other, {
      policies: [simplePolicy(other)],
      budgets: [budgetAccount(other, "budget_b", { type: "organization", id: other }, 100_000)],
      authorities: authoritySeed(other),
    });
    const created = await finance.createRequest(employeeContext(organizationId), createInput(organizationId, "command_iso_create", 3_000));

    expect(await finance.getRequest(other, created.requestId)).toBeNull();
    expect(await finance.getRequest(organizationId, "request_does_not_exist")).toBeNull();

    await finance.seed(organizationId, { authorities: authoritySeed(organizationId, true) });
    await expect(finance.createRequest(employeeContext(organizationId), createInput(organizationId, "command_iso_revoked", 3_000)))
      .rejects.toMatchObject({ code: "AUTHORITY_DENIED" });

    await finance.seed(organizationId, { authorities: authoritySeed(organizationId, false) });
    await expect(finance.amendRequest(employeeContext(organizationId), {
      meta: {
        schemaVersion: "1.0.0", organizationId, commandId: "command_iso_cross", correlationId: "correlation_iso_cross",
        expectedVersions: [
          { ref: { type: "request", id: created.requestId }, expectedRevision: 1 },
          { ref: { type: "budget_account", id: "budget_b" }, expectedRevision: 1 },
        ],
      },
      payload: { requestId: created.requestId, revisedFullAmount: usd(6_000), reason: "Cross tenant" },
    })).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect((await finance.getBudgetAccount(other, "budget_b"))?.outstandingCommitments.amountMinor).toBe(0);
  });

  it("applies accepted imported postings through the canonical posting mutation", async () => {
    const { runtime, finance } = await open();
    const organizationId = "org_northstar";
    const fixture = loadNorthstarFixture();
    await finance.seed(organizationId, {
      budgets: [budgetAccount(organizationId, "budget_imported", { type: "organization", id: organizationId }, 10_000_000)],
      authorities: authoritySeed(organizationId),
    });
    await runtime.imports.seedEntities(fixture.entities.map((entity) => CompanyEntitySchema.parse(entity)));
    await runtime.imports.seedMappings(fixture.manifest.mappings);

    const delivery = SourceDeliverySchema.parse(fixture.deliveries[0]);
    const outcome = await runtime.imports.ingest(delivery);
    expect(outcome.disposition).toBe("accepted");
    const amount = (delivery.payload as { posting: { amount: { amountMinor: number } } }).posting.amount.amountMinor;
    const budget = await finance.getBudgetAccount(organizationId, "budget_imported");
    expect(budget?.recognizedSpend.amountMinor).toBe(amount);
    expect(await runtime.db.collection(AUDIT_EVENTS_COLLECTION).countDocuments({ organizationId, type: "posting.recorded" })).toBe(1);
  });

  it("consumes a human review so a second decision cannot reserve the same capacity twice", async () => {
    const { finance } = await open();
    const organizationId = "org_review_once";
    await finance.seed(organizationId, {
      policies: [simplePolicy(organizationId, { maximumCumulativeIncrease: usd(5_000), cumulativeLimitScope: "purpose", requiredApproverRole: FINANCE_MANAGER_ROLE })],
      budgets: [budgetAccount(organizationId, "budget_review_once", { type: "organization", id: organizationId }, 100_000)],
      authorities: authoritySeed(organizationId),
    });
    const created = await finance.createRequest(employeeContext(organizationId), createInput(organizationId, "command_once_create", 18_000));
    await finance.amendRequest(employeeContext(organizationId), amendInput(organizationId, "command_once_amend1", created.requestId, 1, 21_000));
    await finance.amendRequest(employeeContext(organizationId), amendInput(organizationId, "command_once_amend2", created.requestId, 2, 24_000));
    await finance.decideReview(financeContext(organizationId), reviewInput(organizationId, "command_once_review", created.requestId, 3, "approved"));
    const budgetAfterApproval = await finance.getBudgetAccount(organizationId, "budget_review_once");
    const commitmentAfterApproval = await finance.getCommitment(organizationId, created.requestId);

    await expect(finance.decideReview(financeContext(organizationId), reviewInput(organizationId, "command_once_review_again", created.requestId, 3, "approved")))
      .rejects.toMatchObject({ code: "POLICY_DENIED", details: { reasonCode: "REQUEST_ALREADY_DECIDED" } });
    await expect(finance.decideReview(financeContext(organizationId), reviewInput(organizationId, "command_once_review_denied", created.requestId, 3, "denied")))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(await finance.listApprovalGrants(organizationId, created.requestId)).toHaveLength(1);
    expect((await finance.getCommitment(organizationId, created.requestId))?.outstandingAmount.amountMinor).toBe(commitmentAfterApproval?.outstandingAmount.amountMinor);
    expect((await finance.getBudgetAccount(organizationId, "budget_review_once"))?.outstandingCommitments.amountMinor).toBe(budgetAfterApproval?.outstandingCommitments.amountMinor);
  });

  it("nets a superseded posting revision instead of counting both", async () => {
    const { finance } = await open();
    const organizationId = "org_posting_revision";
    await finance.seed(organizationId, {
      policies: [simplePolicy(organizationId)],
      budgets: [budgetAccount(organizationId, "budget_revision", { type: "organization", id: organizationId }, 100_000)],
      authorities: authoritySeed(organizationId),
    });
    const first = postingFixture(organizationId, "posting_edited", 20_000);
    await finance.recordPosting(financeContext(organizationId), postingInput(organizationId, first, "command_revision_first"));
    expect((await finance.getBudgetAccount(organizationId, "budget_revision"))?.recognizedSpend.amountMinor).toBe(20_000);

    const revised = PostingSchema.parse({ ...first, revision: 2, amount: usd(30_000) });
    await finance.recordPosting(financeContext(organizationId), postingInput(organizationId, revised, "command_revision_second"));
    expect((await finance.getBudgetAccount(organizationId, "budget_revision"))?.recognizedSpend.amountMinor).toBe(30_000);

    // A stale revision delivered before the ledger has seen the lower one is ignored.
    const futureRevision = PostingSchema.parse({ ...postingFixture(organizationId, "posting_future", 30_000), revision: 2 });
    await finance.recordPosting(financeContext(organizationId), postingInput(organizationId, futureRevision, "command_revision_future"));
    const staleLower = PostingSchema.parse({ ...postingFixture(organizationId, "posting_future", 20_000), revision: 1 });
    await finance.recordPosting(financeContext(organizationId), postingInput(organizationId, staleLower, "command_revision_lower"));
    expect((await finance.getBudgetAccount(organizationId, "budget_revision"))?.recognizedSpend.amountMinor).toBe(60_000);
  });

  it("rejects a non-increase amendment as a validation failure", async () => {
    const { finance } = await open();
    const organizationId = "org_non_increase";
    await finance.seed(organizationId, {
      policies: [simplePolicy(organizationId)],
      budgets: [budgetAccount(organizationId, "budget_non_increase", { type: "organization", id: organizationId }, 100_000)],
      authorities: authoritySeed(organizationId),
    });
    const created = await finance.createRequest(employeeContext(organizationId), createInput(organizationId, "command_non_increase_create", 18_000));
    await expect(finance.amendRequest(employeeContext(organizationId), amendInput(organizationId, "command_non_increase_equal", created.requestId, 1, 18_000)))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { reasonCode: "revisedAmountNotAnIncrease" } });
    await expect(finance.amendRequest(employeeContext(organizationId), amendInput(organizationId, "command_non_increase_lower", created.requestId, 1, 15_000)))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("does not let out-of-scope evidence satisfy a policy requirement", async () => {
    const { finance } = await open();
    const organizationId = "org_evidence_scope";
    await finance.seed(organizationId, {
      policies: [simplePolicy(organizationId, { requiredEvidenceKinds: ["document_excerpt"] })],
      budgets: [budgetAccount(organizationId, "budget_evidence", { type: "organization", id: organizationId }, 100_000)],
      evidence: [evidenceFixture(organizationId, "evidence_other_department", [{ type: "department", id: "department_other" }])],
      authorities: authoritySeed(organizationId),
    });
    const blocked = await finance.createRequest(employeeContext(organizationId), createInput(organizationId, "command_evidence_blocked", 18_000));
    expect(blocked.evaluationState).toBe("review_required");
    expect((await finance.listDecisions(organizationId, blocked.requestId)).at(-1)?.reasonCodes).toContain("EVIDENCE_MISSING");

    await finance.seed(organizationId, {
      evidence: [evidenceFixture(organizationId, "evidence_organization", [{ type: "organization", id: organizationId }])],
    });
    const approved = await finance.createRequest(employeeContext(organizationId), createInput(organizationId, "command_evidence_approved", 18_000));
    expect(approved.evaluationState).toBe("approved");
  });

  it("replays the Northstar fixture policy through $180, $210, review, approval, and recovery of the grant", async () => {
    const { finance } = await open();
    const organizationId = "org_northstar";
    await finance.seed(organizationId, northstarSeed(organizationId));
    const scenario = await finance.createRequest(employeeContext(organizationId), {
      meta: { schemaVersion: "1.0.0", organizationId, commandId: "command_northstar_create", correlationId: "correlation_northstar_create", expectedVersions: [] },
      payload: {
        requesterId: EMPLOYEE, purpose: "Buffalo Beacon pilot trip", fullAmount: usd(18_000), categoryId: CATEGORY,
        vendorId: "vendor_buffalo_hotel", projectId: "project_beacon",
        scopes: [
          { type: "organization", id: organizationId },
          { type: "department", id: "department_field_engineering" },
          { type: "project", id: "project_beacon" },
        ],
      },
    });
    expect(scenario.evaluationState).toBe("approved");
    const budgetAfterCreate = await finance.getBudgetAccount(organizationId, "budget_field_travel");
    expect(budgetAfterCreate?.outstandingCommitments.amountMinor).toBe(18_000);

    const amended = await finance.amendRequest(employeeContext(organizationId), amendInput(organizationId, "command_northstar_amend", scenario.requestId, 1, 21_000));
    expect(amended.request.evaluationState).toBe("approved");
    const reviewed = await finance.amendRequest(employeeContext(organizationId), amendInput(organizationId, "command_northstar_review", scenario.requestId, 2, 24_000));
    expect(reviewed.request.evaluationState).toBe("review_required");
    expect((await finance.getCommitment(organizationId, scenario.requestId))?.outstandingAmount.amountMinor).toBe(21_000);

    const approved = await finance.decideReview(financeContext(organizationId), reviewInput(organizationId, "command_northstar_approve", scenario.requestId, 3, "approved"));
    expect(approved.decision.reasonCodes).toEqual(["AUTHORIZED_HUMAN_EXCEPTION"]);
    expect(approved.commitment?.outstandingAmount.amountMinor).toBe(24_000);
    const grants = await finance.listApprovalGrants(organizationId, scenario.requestId);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.approverId).toBe(FINANCE);
    const current = await finance.currentActionIntent(organizationId, scenario.requestId);
    expect(current?.requestRef.revision).toBe(3);
    expect(current?.action.amount.amountMinor).toBe(24_000);
    const intents = await finance.listActionIntents(organizationId, scenario.requestId);
    expect(intents.filter((intent) => intent.state === "canceled")).toHaveLength(2);
    expect(intents.filter((intent) => intent.state === "pending")).toHaveLength(1);

  });
});
