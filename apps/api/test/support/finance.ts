import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BudgetAccountSchema, EvidenceSchema, PolicySchema, PurchaseRequestRevisionSchema, type Policy, type ScopeRef,
} from "@alloc/contracts";
import type { FinancialRepository, FinancialSeed } from "../../src/finance/repository.js";

/** Partial double: any method a test does not override fails loudly instead of silently passing. */
export function financeStub(overrides: Partial<FinancialRepository>): FinancialRepository {
  return new Proxy(overrides as FinancialRepository, {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver);
      }
      return () => {
        throw new Error(`finance.${String(property)} is not configured for this test`);
      };
    },
  });
}

export const FIXED_NOW = "2026-09-12T14:00:00.000Z";
export const NORTHSTAR_ORG = "org_northstar";
export const NORTHSTAR_FIXTURE_PATH = fileURLToPath(
  new URL("../../../../packages/company-fixtures/fixtures/northstar.json", import.meta.url),
);

export interface NorthstarFixture {
  manifest: {
    organizationId: string;
    referenceDate: string;
    mappings: Array<{ sourceInstanceId: string; sourceObjectId: string; entityId: string }>;
  };
  policies: unknown[];
  budgets: unknown[];
  evidence: unknown[];
  deliveries: Array<Record<string, unknown>>;
  entities: Array<{ entityId: string; attributes: Record<string, unknown>; access: { scopeRefs: ScopeRef[] } }>;
  scenario: {
    requestRevisions: unknown[];
    amendments: unknown[];
    initialDecisions: Array<Record<string, unknown>>;
    reviewDecision: Record<string, unknown>;
    approvedDecision: Record<string, unknown>;
    approvalGrant: Record<string, unknown>;
    commitment: Record<string, unknown>;
    actionIntent: Record<string, unknown>;
    posting: Record<string, unknown>;
  };
}

export function loadNorthstarFixture(): NorthstarFixture {
  return JSON.parse(readFileSync(NORTHSTAR_FIXTURE_PATH, "utf8")) as NorthstarFixture;
}

export const northstarPolicy: Policy = PolicySchema.parse(loadNorthstarFixture().policies[0]);

/** Baseline Northstar budget: the fixture's final spend minus the scenario's $240 posting. */
export function northstarBaselineBudget(organizationId = NORTHSTAR_ORG) {
  const final = BudgetAccountSchema.parse(loadNorthstarFixture().budgets[0]);
  return BudgetAccountSchema.parse({
    ...final,
    organizationId,
    revision: 1,
    recognizedSpend: { amountMinor: final.recognizedSpend.amountMinor - 24_000, currency: "USD" },
    outstandingCommitments: { amountMinor: 0, currency: "USD" },
    available: { amountMinor: final.authorized.amountMinor - (final.recognizedSpend.amountMinor - 24_000), currency: "USD" },
  });
}

export function northstarScenario() {
  const scenario = loadNorthstarFixture().scenario;
  return {
    revisions: scenario.requestRevisions.map((value) => PurchaseRequestRevisionSchema.parse(value)),
    initialDecisions: scenario.initialDecisions,
    reviewDecision: scenario.reviewDecision,
    approvedDecision: scenario.approvedDecision,
  };
}

/** The governed records the 2A fixture expects the backend to own. */
export function northstarSeed(organizationId = NORTHSTAR_ORG): FinancialSeed {
  const fixture = loadNorthstarFixture();
  const scenario = northstarScenario();
  const requester = fixture.entities.find((entity) => entity.entityId === "employee_maya_chen")!;
  const approver = fixture.entities.find((entity) => entity.entityId === "employee_avery_finance")!;
  const evidence = fixture.evidence.map((value) => EvidenceSchema.parse(value));
  const purposeEvidence = evidence.find((item) => item.kind === "document_excerpt")!;
  return {
    policies: [northstarPolicy],
    budgets: [northstarBaselineBudget(organizationId)],
    evidence,
    purposes: [{ purpose: scenario.revisions[0]!.purpose, active: true, ref: { type: "evidence", id: purposeEvidence.evidenceId, revision: purposeEvidence.revision } }],
    authorities: [
      { principalId: "employee_maya_chen", roles: [String(requester.attributes.role)], scopes: requester.access.scopeRefs },
      { principalId: "employee_avery_finance", roles: [String(approver.attributes.role)], scopes: approver.access.scopeRefs },
    ],
  };
}
