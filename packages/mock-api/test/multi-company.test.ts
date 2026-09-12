import { describe, expect, it } from "vitest";
import { forgePack, juniperPack, northstarPack } from "../src/packs.js";
import type { CompanyPack } from "../src/packs.js";
import {
  callError, callOk, commandMeta, companyFixture, moneyMinor, queryMeta, startMock, versionExpectation,
} from "./harness.js";
import type { CompanyFixture } from "./harness.js";

const OCCURRED_AT = "2026-09-12T14:30:00Z";

interface CompanyRun {
  organizationId: string;
  requestId: string;
  commitmentId: string;
  budgetAccountId: string;
  revisions: number[];
  states: string[];
  amounts: number[];
  decisionOutcomes: string[];
  commitmentState: string;
  commitmentOutstanding: number;
  postingAmount: number;
  budgetOutstanding: number;
  budgetAvailable: number;
}

function postingInput(company: CompanyFixture, commitmentRevision: number) {
  return {
    postingId: `posting_${company.requestId}`,
    revision: 1,
    amount: { amountMinor: 24_000, currency: "USD" },
    occurredAt: OCCURRED_AT,
    status: "posted",
    commitmentRef: { type: "commitment", id: company.commitmentId, revision: commitmentRevision },
    sourceRef: { type: "source_delivery", id: `delivery_${company.requestId}`, revision: 1 },
    scopes: company.requestScopes,
    provenance: {
      kind: "synthetic" as const,
      trust: "authoritative" as const,
      sourceInstanceId: "source_multi_driver",
      sourceObjectId: `${company.requestId}-settlement`,
      sourceRevision: "1",
      occurredAt: OCCURRED_AT,
      observedAt: OCCURRED_AT,
    },
  };
}

/** The full 18_000 → 21_000 → 24_000 trace for one pack, all over HTTP. */
async function runCompany(url: string, pack: CompanyPack): Promise<CompanyRun> {
  const company = companyFixture(pack);
  const org = company.organizationId;
  const amendment = (index: number, expectedRevision: number, revisedAmountMinor: number) => ({
    meta: commandMeta(`command_multi_amend_${index}`, `correlation_multi_amend_${index}`, org, [
      versionExpectation({ type: "request", id: company.requestId }, expectedRevision),
    ]),
    payload: { requestId: company.requestId, revisedFullAmount: { amountMinor: revisedAmountMinor, currency: "USD" }, reason: "Operating cost amendment" },
  });

  const seeded = await callOk(url, "requests.get", { meta: queryMeta("correlation_multi_get", org), payload: { requestId: company.requestId } });
  const first = await callOk(url, "requests.amend", amendment(1, 1, 21_000));
  const second = await callOk(url, "requests.amend", amendment(2, 2, 24_000));
  const decided = await callOk(url, "reviews.decide", {
    meta: commandMeta("command_multi_decide", "correlation_multi_decide", org),
    payload: { requestId: company.requestId, requestRevision: 3, outcome: "approved", rationale: "Reviewed and approved" },
  }, { principalId: company.approverId });
  const commitmentRevision = decided.data.commitment?.revision ?? 1;
  const posting = await callOk(url, "postings.record", {
    meta: commandMeta("command_multi_posting", "correlation_multi_posting", org, [
      versionExpectation({ type: "commitment", id: company.commitmentId }, commitmentRevision),
    ]),
    payload: postingInput(company, commitmentRevision),
  });
  const settled = await callOk(url, "requests.get", { meta: queryMeta("correlation_multi_settled", org), payload: { requestId: company.requestId } });
  const budget = await callOk(url, "memory.query", {
    meta: queryMeta("correlation_multi_budget", org),
    payload: { query: "Budget", scopes: [company.tenantScope], page: { limit: 25 } },
  });
  const factOf = (label: string): number => {
    const fact = budget.data.facts.find((candidate) => candidate.label === label);
    if (!fact) throw new Error(`missing budget fact ${label} for ${org}`);
    return moneyMinor(fact.value, label);
  };

  return {
    organizationId: org,
    requestId: company.requestId,
    commitmentId: company.commitmentId,
    budgetAccountId: company.budgetAccountId,
    revisions: [seeded.data.request.revision, first.data.request.revision, second.data.request.revision],
    states: [seeded.data.request.evaluationState, first.data.request.evaluationState, second.data.request.evaluationState],
    amounts: [
      seeded.data.request.fullAmount.amountMinor,
      first.data.request.fullAmount.amountMinor,
      second.data.request.fullAmount.amountMinor,
    ],
    decisionOutcomes: settled.data.decisions.map((decision) => decision.outcome),
    commitmentState: settled.data.commitment?.state ?? "missing",
    commitmentOutstanding: settled.data.commitment?.outstandingAmount.amountMinor ?? -1,
    postingAmount: posting.data.amount.amountMinor,
    budgetOutstanding: factOf("Budget outstanding commitments"),
    budgetAvailable: factOf("Budget available amount"),
  };
}

describe("provisional company packs", () => {
  it("drives the same structural states for all three companies with their own IDs", async () => {
    const { api, url } = await startMock();
    try {
      const runs = [await runCompany(url, northstarPack), await runCompany(url, juniperPack), await runCompany(url, forgePack)];
      const expected = {
        revisions: [1, 2, 3],
        states: ["approved", "approved", "review_required"],
        amounts: [18_000, 21_000, 24_000],
        decisionOutcomes: ["approved", "approved", "review_required", "approved"],
        commitmentState: "posted",
        commitmentOutstanding: 0,
        postingAmount: 24_000,
        budgetOutstanding: 0,
        budgetAvailable: 14_000,
      };
      for (const run of runs) {
        const { organizationId: _organizationId, requestId: _requestId, commitmentId: _commitmentId, budgetAccountId: _budgetAccountId, ...structure } = run;
        expect(structure).toEqual(expected);
      }
      expect(new Set(runs.map((run) => run.organizationId)).size).toBe(3);
      expect(new Set(runs.map((run) => run.requestId)).size).toBe(3);
      expect(new Set(runs.map((run) => run.commitmentId)).size).toBe(3);
      expect(new Set(runs.map((run) => run.budgetAccountId)).size).toBe(3);
    } finally {
      await api.close();
    }
  });

  it("keeps organizations, scopes, and principals separate", async () => {
    const { api, url } = await startMock();
    try {
      const northstar = companyFixture(northstarPack);
      const juniper = companyFixture(juniperPack);
      expect(juniper.projectScope).toBeNull();

      const foreignRequest = await callError(url, "requests.get", {
        meta: queryMeta("correlation_multi_foreign_request", northstar.organizationId),
        payload: { requestId: juniper.requestId },
      });
      expect(foreignRequest.status).toBe(404);
      expect(foreignRequest.error.code).toBe("NOT_FOUND");

      const foreignScope = await callError(url, "memory.query", {
        meta: queryMeta("correlation_multi_foreign_scope", northstar.organizationId),
        payload: { query: "Budget", scopes: [juniper.departmentScope], page: { limit: 25 } },
      });
      expect(foreignScope.status).toBe(403);
      expect(foreignScope.error.code).toBe("ACCESS_DENIED");

      const foreignPrincipal = await callError(url, "requests.get", {
        meta: queryMeta("correlation_multi_foreign_principal", northstar.organizationId),
        payload: { requestId: northstar.requestId },
      }, { principalId: juniper.requesterId });
      expect(foreignPrincipal.status).toBe(403);
      expect(foreignPrincipal.error.code).toBe("ACCESS_DENIED");

      const ownOrganization = await callOk(url, "requests.get", {
        meta: queryMeta("correlation_multi_own", juniper.organizationId),
        payload: { requestId: juniper.requestId },
      }, { principalId: juniper.requesterId });
      expect(ownOrganization.data.request.organizationId).toBe(juniper.organizationId);
    } finally {
      await api.close();
    }
  });
});
