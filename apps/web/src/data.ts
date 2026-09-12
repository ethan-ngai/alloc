import { ContractClientError, createContractClient } from "@alloc/mock-api";
import type { OperationInput } from "@alloc/mock-api";

export type CompanyKey = "northstar" | "juniper" | "forge";
export type DemoState = "baseline" | "review" | "unavailable";

export interface CompanyConfig {
  key: CompanyKey;
  organizationId: string;
  name: string;
  shortName: string;
  departmentId: string;
  departmentName: string;
  projectName?: string;
  requestId: string;
  requestPurpose: string;
  requester: string;
  requesterId: string;
  approver: string;
  approverInitials: string;
  approverId: string;
  forecastId: string;
  categories: string[];
}

export const companies: CompanyConfig[] = [
  {
    key: "northstar",
    organizationId: "org_northstar",
    name: "Northstar Fieldworks",
    shortName: "Northstar",
    departmentId: "department_field_engineering",
    departmentName: "Field engineering",
    projectName: "Beacon pilot",
    requestId: "request_buffalo_trip",
    requestPurpose: "Buffalo Beacon pilot trip",
    requester: "Maya Chen",
    requesterId: "employee_maya_chen",
    approver: "Avery Finance",
    approverInitials: "AF",
    approverId: "employee_avery_finance",
    forecastId: "forecast_field_engineering",
    categories: ["Travel", "Cloud services", "Field equipment"],
  },
  {
    key: "juniper",
    organizationId: "org_juniper_table",
    name: "Juniper Table",
    shortName: "Juniper",
    departmentId: "department_kitchen_operations",
    departmentName: "Kitchen operations",
    requestId: "request_juniper_pos_rollout",
    requestPurpose: "Refrigeration maintenance visit",
    requester: "Rosa Ibarra",
    requesterId: "employee_rosa_ibarra",
    approver: "Sam Delgado",
    approverInitials: "SD",
    approverId: "employee_sam_delgado",
    forecastId: "forecast_kitchen_operations",
    categories: ["Food cost", "Labor", "Rent & utilities"],
  },
  {
    key: "forge",
    organizationId: "org_forge_loom",
    name: "Forge & Loom",
    shortName: "Forge",
    departmentId: "department_line_operations",
    departmentName: "Line operations",
    projectName: "Line retrofit",
    requestId: "request_forge_freight_revision",
    requestPurpose: "Line maintenance freight revision",
    requester: "Dana Okafor",
    requesterId: "employee_dana_okafor",
    approver: "Leo Brandt",
    approverInitials: "LB",
    approverId: "employee_leo_brandt",
    forecastId: "forecast_line_operations",
    categories: ["Raw materials", "Freight", "Equipment lease"],
  },
];

export interface MoneyValue {
  amountMinor: number;
  currency: string;
}

export interface WorkspaceData {
  request: {
    revision: number;
    purpose: string;
    state: string;
    fullAmount: MoneyValue;
    cumulativeIncrease: MoneyValue;
    submittedAt: string;
    sourceRevision: string;
  };
  decisionReason: string;
  budget: Record<"authorized" | "recognized" | "committed" | "available", MoneyValue>;
  facts: Array<{ label: string; value: unknown; source: string; trust: string }>;
  evidence: Array<{ title: string; content: string; trust: string; source: string }>;
  forecast: {
    revision: number;
    total: MoneyValue;
    asOf: string;
    horizonEnd: string;
    components: Array<{ kind: string; amount: MoneyValue }>;
    warnings: string[];
  };
  activity: Array<{ id: string; type: string; occurredAt: string; summary: string }>;
  asOf: string;
  scenarioId: string;
}

export async function loadActivity(company: CompanyConfig): Promise<WorkspaceData["activity"]> {
  const client = createContractClient({ baseUrl: API_URL, principalId: company.requesterId });
  const envelope = await client.expect("activity.list", {
    meta: meta(company, `activity_live_${Date.now()}`),
    payload: { scopes: [{ type: "organization", id: company.organizationId }], page: { limit: 25 } },
  });
  return envelope.data.items.map((item) => ({
    id: item.activityId,
    type: item.type,
    occurredAt: item.occurredAt,
    summary: item.summary,
  }));
}

const API_URL = import.meta.env.VITE_MOCK_API_URL ?? "http://127.0.0.1:55041";

function meta(company: CompanyConfig, suffix: string) {
  return {
    schemaVersion: "1.0.0" as const,
    organizationId: company.organizationId,
    correlationId: `correlation_web_${company.key}_${suffix}`,
  };
}

function commandMeta(company: CompanyConfig, command: string, expectedVersions: Array<{ ref: { type: string; id: string }; expectedRevision: number }> = []) {
  return {
    ...meta(company, command),
    commandId: `command_web_${company.key}_${command}`,
    expectedVersions,
  };
}

async function resetCompany(company: CompanyConfig) {
  const response = await fetch(`${API_URL}/admin/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: company.organizationId }),
  });
  if (!response.ok) throw new Error(`Could not reset mock scenario (${response.status})`);
}

async function prepareReview(company: CompanyConfig) {
  await resetCompany(company);
  const client = createContractClient({ baseUrl: API_URL, principalId: company.requesterId });
  const first: OperationInput<"requests.amend"> = {
    meta: commandMeta(company, "amend_1", [{ ref: { type: "request", id: company.requestId }, expectedRevision: 1 }]),
    payload: {
      requestId: company.requestId,
      revisedFullAmount: { amountMinor: 21_000, currency: "USD" },
      reason: "Updated operating estimate",
    },
  };
  const second: OperationInput<"requests.amend"> = {
    meta: commandMeta(company, "amend_2", [{ ref: { type: "request", id: company.requestId }, expectedRevision: 2 }]),
    payload: {
      requestId: company.requestId,
      revisedFullAmount: { amountMinor: 24_000, currency: "USD" },
      reason: "Final scope confirmed",
    },
  };
  await client.expect("requests.amend", first);
  await client.expect("requests.amend", second);
}

function moneyFact(facts: Array<{ label: string; value: unknown }>, label: string): MoneyValue {
  const value = facts.find((fact) => fact.label === label)?.value;
  if (!value || typeof value !== "object" || !("amountMinor" in value) || !("currency" in value)) {
    throw new Error(`Required financial fact is missing or invalid: ${label}`);
  }
  return value as MoneyValue;
}

export async function loadWorkspace(company: CompanyConfig, state: DemoState): Promise<WorkspaceData> {
  if (state === "review") await prepareReview(company);
  if (state === "baseline") await resetCompany(company);

  const client = createContractClient({
    baseUrl: API_URL,
    principalId: company.requesterId,
    ...(state === "unavailable" ? { fault: "DEPENDENCY_UNAVAILABLE" as const } : {}),
  });
  const organizationScope = { type: "organization" as const, id: company.organizationId };

  const [requestEnvelope, memoryEnvelope, forecastEnvelope, activityEnvelope] = await Promise.all([
    client.expect("requests.get", { meta: meta(company, "request"), payload: { requestId: company.requestId } }),
    client.expect("memory.query", {
      meta: meta(company, "memory"),
      payload: { query: "Budget", scopes: [organizationScope], page: { limit: 25 } },
    }),
    client.expect("forecasts.get", { meta: meta(company, "forecast"), payload: { forecastId: company.forecastId } }),
    client.expect("activity.list", {
      meta: meta(company, "activity"),
      payload: { scopes: [organizationScope], page: { limit: 25 } },
    }),
  ]);

  const memory = memoryEnvelope.data;
  const forecast = forecastEnvelope.data;
  const request = requestEnvelope.data.request;
  const decision = requestEnvelope.data.decisions.at(-1);
  const commitment = requestEnvelope.data.commitment;

  return {
    request: {
      revision: request.revision,
      purpose: request.purpose,
      state: request.evaluationState,
      fullAmount: request.fullAmount,
      cumulativeIncrease: request.cumulativeIncrease,
      submittedAt: request.submittedAt,
      sourceRevision: request.provenance.sourceRevision,
    },
    decisionReason: decision?.reasonCodes.join(" · ") ?? "CUMULATIVE_AMENDMENT_LIMIT_EXCEEDED",
    budget: {
      authorized: moneyFact(memory.facts, "Budget authorized amount"),
      recognized: moneyFact(memory.facts, "Budget recognized spend"),
      committed: commitment?.outstandingAmount ?? moneyFact(memory.facts, "Budget outstanding commitments"),
      available: moneyFact(memory.facts, "Budget available amount"),
    },
    facts: memory.facts.map((fact) => ({
      label: fact.label,
      value: fact.value,
      source: fact.provenance.sourceInstanceId,
      trust: fact.provenance.trust,
    })),
    evidence: memory.evidence.map((item) => ({
      title: item.title,
      content: item.content,
      trust: item.provenance.trust,
      source: item.provenance.sourceInstanceId,
    })),
    forecast: {
      revision: forecast.revision,
      total: forecast.total,
      asOf: forecast.asOfCutoff,
      horizonEnd: forecast.horizonEnd,
      components: forecast.components.map((component) => ({ kind: component.kind, amount: component.amount })),
      warnings: forecast.coverageWarnings,
    },
    activity: activityEnvelope.data.items.map((item) => ({
      id: item.activityId,
      type: item.type,
      occurredAt: item.occurredAt,
      summary: item.summary,
    })),
    asOf: memory.asOf,
    scenarioId: memory.sourceWatermarks.mock_scenario ?? `scenario_mock_${company.key}_v1`,
  };
}

export async function approveReview(company: CompanyConfig, revision: number) {
  const client = createContractClient({ baseUrl: API_URL, principalId: company.approverId });
  await client.expect("reviews.decide", {
    meta: commandMeta(company, `decide_${revision}`),
    payload: {
      requestId: company.requestId,
      requestRevision: revision,
      outcome: "approved",
      rationale: "Reviewed against current scope and approved in the synthetic demo",
    },
  });
}

export function describeError(error: unknown) {
  if (error instanceof ContractClientError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      correlationId: error.correlationId,
    };
  }
  return {
    code: "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : "The workspace could not be loaded.",
    retryable: true,
    correlationId: "correlation_web_unknown",
  };
}
