import type {
  Commitment, Decision, Evidence, ForecastSnapshot, Posting, PurchaseRequestRevision,
} from "@alloc/contracts";
import { CONTRACT_SCHEMA_VERSION } from "@alloc/contracts";
import type { BudgetAccount, Policy, Provenance, ScopeRef } from "./contract-types.js";
import { DEFAULT_MOCK_CLOCK } from "./clock.js";
import { forecastIdForScope } from "./ids.js";
import { usd } from "./money.js";

/**
 * Provisional company packs. These are 2C-owned synthetic datasets labelled `provenance.kind:
 * "synthetic"` throughout; they exist so the frontend (8A) can build screens without a backend and
 * without consuming 2A's `packages/company-fixtures` manifests. `MockApiOptions.packs` is the
 * injection seam that replaces them.
 *
 * Every pack is the same 18_000 / 21_000 / 24_000 amendment scenario with per-industry labels.
 * A pack is a frozen *template*: the store deep-clones it before mutating, so importers must never
 * treat a returned pack as mutable state.
 */
export interface CompanyIdentity {
  organizationId: string;
  displayName: string;
  scenarioId: string;
  department: { id: string; name: string };
  project: { id: string; name: string } | null;
  requester: { id: string; name: string };
  approver: { id: string; name: string };
  categories: Array<{ id: string; name: string }>;
  vendor: { id: string; name: string };
  budgetAccountId: string;
  requestId: string;
  requestPurpose: string;
  commitmentId: string;
}

export interface PackPrincipal {
  principalId: string;
  displayName: string;
  authorityRole: string | null;
  scopeRefs: ScopeRef[];
}

export interface CompanyPack {
  identity: CompanyIdentity;
  seededAt: string;
  policy: Policy;
  budgetAccount: BudgetAccount;
  request: PurchaseRequestRevision;
  decision: Decision;
  commitment: Commitment;
  posting: Posting;
  evidence: Evidence;
  forecast: ForecastSnapshot;
  principals: readonly PackPrincipal[];
  defaultPrincipalId: string;
}

/** References registered for one authenticated organization; writes may only name these. */
export interface PackRegistry {
  organizationId: string;
  scopeRefs: readonly ScopeRef[];
  categoryIds: readonly string[];
  vendorId: string;
  projectId: string | null;
  employeeIds: readonly string[];
  budgetAccountId: string;
  requestId: string;
  commitmentId: string;
  tenantScope: ScopeRef;
}

export const MOCK_SOURCE_INSTANCE_ID = "source_mock_simulator";
export const SEEDED_EVIDENCE_ID = "evidence_trip_active";
export const SEEDED_POLICY_ID = "policy_travel";
export const SEEDED_DECISION_ID = "decision_mock_seed_approval";
export const SEEDED_POSTING_ID = "posting_mock_seed_spend";
export const SEEDED_DELIVERY_ID = "delivery_mock_seed";
export const MOCK_CALCULATION_VERSION = "mock-operational-spend-v1";
export const MOCK_FORECAST_HORIZON_END = "2026-09-30T23:59:59Z";

const SEEDED_FULL_AMOUNT = 18_000;
const SEEDED_RECOGNIZED_SPEND = 12_000;
const SEEDED_COMMITMENT_TOTAL = 18_000;
const SEEDED_AUTHORIZED = 50_000;
const SEEDED_PERIOD_START = "2026-07-01";
const SEEDED_PERIOD_END = "2026-09-30";

export function createProvenance(
  instant: string,
  sourceObjectId: string,
  trust: "authoritative" | "evidence" = "authoritative",
): Provenance {
  return {
    kind: "synthetic",
    trust,
    sourceInstanceId: MOCK_SOURCE_INSTANCE_ID,
    sourceObjectId,
    sourceRevision: "1",
    occurredAt: instant,
    observedAt: instant,
  };
}

export function identityScopes(identity: CompanyIdentity): ScopeRef[] {
  return [
    { type: "organization", id: identity.organizationId },
    { type: "department", id: identity.department.id },
    ...(identity.project ? [{ type: "project" as const, id: identity.project.id }] : []),
  ];
}

export function createCompanyPack(identity: CompanyIdentity, seedIso: string = DEFAULT_MOCK_CLOCK): CompanyPack {
  const scopes = identityScopes(identity);
  const departmentScope: ScopeRef = { type: "department", id: identity.department.id };
  const policyRef = { type: "policy", id: SEEDED_POLICY_ID, revision: 1 };
  const requestRef = { type: "request", id: identity.requestId, revision: 1 };
  const evidenceRef = { type: "evidence", id: SEEDED_EVIDENCE_ID, revision: 1 };

  const request: PurchaseRequestRevision = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: identity.organizationId,
    requestId: identity.requestId,
    revision: 1,
    previousRevision: null,
    requesterId: identity.requester.id,
    purpose: identity.requestPurpose,
    fullAmount: usd(SEEDED_FULL_AMOUNT),
    increaseFromPrevious: usd(0),
    cumulativeIncrease: usd(0),
    categoryId: identity.categories[0]?.id ?? "category_uncategorized",
    vendorId: identity.vendor.id,
    ...(identity.project ? { projectId: identity.project.id } : {}),
    scopes,
    evaluationState: "approved",
    submittedAt: seedIso,
    provenance: createProvenance(seedIso, `${identity.requestId}-seed`),
  };

  const decision: Decision = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: identity.organizationId,
    decisionId: SEEDED_DECISION_ID,
    requestRef,
    outcome: "approved",
    reasonCodes: ["WITHIN_AUTO_APPROVAL_LIMITS"],
    policyRef,
    authorizationEpoch: 1,
    evaluatedFullAmount: usd(SEEDED_FULL_AMOUNT),
    evaluatedCumulativeIncrease: usd(0),
    factualInputs: [requestRef, policyRef],
    evidenceRefs: [evidenceRef],
    requiredApproverRole: null,
    permittedAction: { type: "simulate_purchase", amount: usd(SEEDED_FULL_AMOUNT) },
    decidedAt: seedIso,
  };

  const commitment: Commitment = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: identity.organizationId,
    commitmentId: identity.commitmentId,
    revision: 1,
    requestRef,
    decisionRef: { type: "decision", id: SEEDED_DECISION_ID, revision: 1 },
    amount: usd(SEEDED_FULL_AMOUNT),
    outstandingAmount: usd(SEEDED_FULL_AMOUNT),
    state: "outstanding",
    budgetAccountRefs: [{ type: "budget_account", id: identity.budgetAccountId, revision: 1 }],
    createdAt: seedIso,
  };

  const posting: Posting = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: identity.organizationId,
    postingId: SEEDED_POSTING_ID,
    revision: 1,
    amount: usd(SEEDED_RECOGNIZED_SPEND),
    occurredAt: seedIso,
    status: "posted",
    sourceRef: { type: "source_delivery", id: SEEDED_DELIVERY_ID, revision: 1 },
    scopes: scopes.slice(0, 2),
    provenance: createProvenance(seedIso, "seed-operating-spend"),
  };

  const budgetAccount: BudgetAccount = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: identity.organizationId,
    budgetAccountId: identity.budgetAccountId,
    revision: 1,
    scope: departmentScope,
    authorized: usd(SEEDED_AUTHORIZED),
    recognizedSpend: usd(SEEDED_RECOGNIZED_SPEND),
    outstandingCommitments: usd(SEEDED_COMMITMENT_TOTAL),
    available: usd(SEEDED_AUTHORIZED - SEEDED_RECOGNIZED_SPEND - SEEDED_COMMITMENT_TOTAL),
    hardCap: true,
    periodStart: SEEDED_PERIOD_START,
    periodEnd: SEEDED_PERIOD_END,
  };

  const evidence: Evidence = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: identity.organizationId,
    evidenceId: SEEDED_EVIDENCE_ID,
    revision: 1,
    kind: "source_record",
    title: `${identity.displayName} active trip authorization`,
    content: `Synthetic authorization record backing the active purpose of ${identity.requestPurpose}.`,
    access: { classification: "internal", scopeRefs: scopes.slice(0, 2), allowedPrincipalIds: [] },
    provenance: createProvenance(seedIso, "seed-trip-authorization", "evidence"),
    authoritativeFor: ["trip_active"],
  };

  const forecast: ForecastSnapshot = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: identity.organizationId,
    forecastId: forecastIdForScope(departmentScope),
    revision: 1,
    kind: "baseline",
    scope: departmentScope,
    asOfCutoff: seedIso,
    horizonEnd: MOCK_FORECAST_HORIZON_END,
    calculationVersion: MOCK_CALCULATION_VERSION,
    inputVersions: [
      { type: "posting", id: SEEDED_POSTING_ID, revision: 1 },
      { type: "commitment", id: identity.commitmentId, revision: 1 },
    ],
    sourceWatermarks: { mock_scenario: identity.scenarioId, mock_clock: seedIso, mock_request_count: "1" },
    assumptions: [],
    components: [
      { kind: "actual_spend", amount: usd(SEEDED_RECOGNIZED_SPEND), inputRefs: [{ type: "posting", id: SEEDED_POSTING_ID, revision: 1 }] },
      { kind: "outstanding_commitment", amount: usd(SEEDED_COMMITMENT_TOTAL), inputRefs: [{ type: "commitment", id: identity.commitmentId, revision: 1 }] },
    ],
    total: usd(SEEDED_RECOGNIZED_SPEND + SEEDED_COMMITMENT_TOTAL),
    sensitivity: {
      low: usd(SEEDED_RECOGNIZED_SPEND + SEEDED_COMMITMENT_TOTAL),
      base: usd(SEEDED_RECOGNIZED_SPEND + SEEDED_COMMITMENT_TOTAL),
      high: usd(SEEDED_RECOGNIZED_SPEND + SEEDED_COMMITMENT_TOTAL),
      calibratedProbability: false,
    },
    coverageWarnings: [],
    completedAt: seedIso,
  };

  const policy: Policy = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: identity.organizationId,
    policyId: SEEDED_POLICY_ID,
    revision: 1,
    authorizationEpoch: 1,
    name: "Travel and operating spend policy",
    scope: departmentScope,
    effectiveFrom: seedIso,
    effectiveTo: null,
    rules: [
      {
        ruleId: "rule_require_review",
        effect: "require_review",
        categoryIds: identity.categories.map((category) => category.id),
        requesterRoles: ["employee"],
        maximumFullAmount: usd(25_000),
        maximumCumulativeIncrease: usd(5_000),
        requireActivePurpose: true,
        requiredEvidenceKinds: ["trip_active"],
      },
    ],
    publishedBy: identity.approver.id,
  };

  return Object.freeze({
    identity,
    seededAt: seedIso,
    policy,
    budgetAccount,
    request,
    decision,
    commitment,
    posting,
    evidence,
    forecast,
    principals: Object.freeze([
      Object.freeze({
        principalId: identity.requester.id,
        displayName: identity.requester.name,
        authorityRole: null,
        scopeRefs: scopes,
      }),
      Object.freeze({
        principalId: identity.approver.id,
        displayName: identity.approver.name,
        authorityRole: "finance_manager",
        scopeRefs: [scopes[0]!, departmentScope],
      }),
    ]),
    defaultPrincipalId: identity.requester.id,
  });
}

export function createPackRegistry(pack: CompanyPack): PackRegistry {
  const identity = pack.identity;
  return {
    organizationId: identity.organizationId,
    scopeRefs: identityScopes(identity),
    categoryIds: identity.categories.map((category) => category.id),
    vendorId: identity.vendor.id,
    projectId: identity.project?.id ?? null,
    employeeIds: [identity.requester.id, identity.approver.id],
    budgetAccountId: identity.budgetAccountId,
    requestId: identity.requestId,
    commitmentId: identity.commitmentId,
    tenantScope: { type: "organization", id: identity.organizationId },
  };
}

const NORTHSTAR_IDENTITY: CompanyIdentity = {
  organizationId: "org_northstar",
  displayName: "Northstar Fieldworks",
  scenarioId: "scenario_mock_northstar_v1",
  department: { id: "department_field_engineering", name: "Field engineering" },
  project: { id: "project_beacon", name: "Beacon pilot" },
  requester: { id: "employee_maya_chen", name: "Maya Chen" },
  approver: { id: "employee_avery_finance", name: "Avery Finance" },
  categories: [
    { id: "category_travel", name: "Travel" },
    { id: "category_cloud", name: "Cloud services" },
    { id: "category_equipment", name: "Field equipment" },
  ],
  vendor: { id: "vendor_buffalo_hotel", name: "Buffalo Hotel" },
  budgetAccountId: "budget_field_travel",
  requestId: "request_buffalo_trip",
  requestPurpose: "Buffalo Beacon pilot trip",
  commitmentId: "commitment_buffalo_trip",
};

const JUNIPER_IDENTITY: CompanyIdentity = {
  organizationId: "org_juniper_table",
  displayName: "Juniper Table",
  scenarioId: "scenario_mock_juniper_v1",
  department: { id: "department_kitchen_operations", name: "Kitchen operations" },
  project: null,
  requester: { id: "employee_rosa_ibarra", name: "Rosa Ibarra" },
  approver: { id: "employee_sam_delgado", name: "Sam Delgado" },
  categories: [
    { id: "category_food_cost", name: "Food cost" },
    { id: "category_labor", name: "Labor" },
    { id: "category_rent_utilities", name: "Rent and utilities" },
  ],
  vendor: { id: "vendor_produce_coop", name: "Produce Coop" },
  budgetAccountId: "budget_kitchen_operations",
  requestId: "request_juniper_pos_rollout",
  requestPurpose: "POS rollout at Riverside location",
  commitmentId: "commitment_juniper_pos_rollout",
};

const FORGE_IDENTITY: CompanyIdentity = {
  organizationId: "org_forge_loom",
  displayName: "Forge & Loom",
  scenarioId: "scenario_mock_forge_v1",
  department: { id: "department_line_operations", name: "Line operations" },
  project: { id: "project_line_retrofit", name: "Line retrofit" },
  requester: { id: "employee_dana_okafor", name: "Dana Okafor" },
  approver: { id: "employee_leo_brandt", name: "Leo Brandt" },
  categories: [
    { id: "category_raw_materials", name: "Raw materials" },
    { id: "category_freight", name: "Freight" },
    { id: "category_equipment_lease", name: "Equipment lease" },
  ],
  vendor: { id: "vendor_steel_supply", name: "Steel Supply" },
  budgetAccountId: "budget_line_operations",
  requestId: "request_forge_freight_revision",
  requestPurpose: "Expedited freight for retrofit parts",
  commitmentId: "commitment_forge_freight_revision",
};

export const COMPANY_IDENTITIES: readonly CompanyIdentity[] = Object.freeze([
  NORTHSTAR_IDENTITY,
  JUNIPER_IDENTITY,
  FORGE_IDENTITY,
]);

export const northstarPack: CompanyPack = createCompanyPack(NORTHSTAR_IDENTITY);
export const juniperPack: CompanyPack = createCompanyPack(JUNIPER_IDENTITY);
export const forgePack: CompanyPack = createCompanyPack(FORGE_IDENTITY);

export function createCompanyPacks(seedIso: string = DEFAULT_MOCK_CLOCK): CompanyPack[] {
  return COMPANY_IDENTITIES.map((identity) => createCompanyPack(identity, seedIso));
}
