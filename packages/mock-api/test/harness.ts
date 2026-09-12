import { CONTRACT_SCHEMA_VERSION, OperationSchemas } from "@alloc/contracts";
import type { ContractError, OperationResult, OperationName } from "@alloc/contracts";
import { createMockApi } from "../src/api.js";
import type { MockApi, MockApiOptions } from "../src/api.js";
import { MOCK_FAULT_HEADER, MOCK_PRINCIPAL_HEADER, ContractClientError } from "../src/client.js";
import type { CommandMeta, QueryMeta, ScopeRef, VersionExpectation } from "../src/contract-types.js";
import type { CompanyPack } from "../src/packs.js";

export type OperationData<Name extends OperationName> = Extract<OperationResult<Name>, { ok: true }>["data"];

export interface MockHeaders {
  principalId?: string;
  fault?: string;
}

export interface RunningMock {
  api: MockApi;
  url: string;
}

/** Real HTTP only: every suite talks to a listening server, never to handlers in process. */
export async function startMock(options: MockApiOptions = {}): Promise<RunningMock> {
  const api = createMockApi(options);
  const { url } = await api.listen(0, "127.0.0.1");
  return { api, url };
}

export interface RawResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

export async function requestJson(url: string, path: string, init: RequestInit = {}): Promise<RawResponse> {
  const response = await fetch(`${url}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : (JSON.parse(text) as unknown), headers: response.headers };
}

export async function postOperation(url: string, name: OperationName, input: unknown, headers: MockHeaders = {}): Promise<RawResponse> {
  const requestHeaders: Record<string, string> = { "content-type": "application/json" };
  if (headers.principalId !== undefined) requestHeaders[MOCK_PRINCIPAL_HEADER] = headers.principalId;
  if (headers.fault !== undefined) requestHeaders[MOCK_FAULT_HEADER] = headers.fault;
  return requestJson(url, `/operations/${name}`, {
    method: "POST",
    headers: requestHeaders,
    body: typeof input === "string" ? input : JSON.stringify(input),
  });
}

export function parseResult<Name extends OperationName>(name: Name, body: unknown): OperationResult<Name> {
  const parsed = OperationSchemas[name].result.safeParse(body);
  if (!parsed.success) throw new Error(`response for ${name} violates the contract: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data as OperationResult<Name>;
}

export async function call<Name extends OperationName>(
  url: string,
  name: Name,
  input: unknown,
  headers: MockHeaders = {},
): Promise<{ status: number; result: OperationResult<Name> }> {
  const response = await postOperation(url, name, input, headers);
  return { status: response.status, result: parseResult(name, response.body) };
}

export async function callOk<Name extends OperationName>(
  url: string,
  name: Name,
  input: unknown,
  headers: MockHeaders = {},
): Promise<{ status: number; data: OperationData<Name> }> {
  const { status, result } = await call(url, name, input, headers);
  if (!result.ok) throw new Error(`${name} failed with ${result.error.code}: ${result.error.message}`);
  return { status, data: result.data };
}

export async function callError<Name extends OperationName>(
  url: string,
  name: Name,
  input: unknown,
  headers: MockHeaders = {},
): Promise<{ status: number; error: ContractError }> {
  const { status, result } = await call(url, name, input, headers);
  if (result.ok) throw new Error(`${name} unexpectedly succeeded`);
  return { status, error: result.error };
}

export function queryMeta(correlationId: string, organizationId: string): QueryMeta {
  return { schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId, correlationId };
}

export function commandMeta(
  commandId: string,
  correlationId: string,
  organizationId: string,
  expectedVersions: VersionExpectation[] = [],
): CommandMeta {
  return { schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId, commandId, correlationId, expectedVersions };
}

export function versionExpectation(ref: { type: string; id: string }, expectedRevision: number): VersionExpectation {
  return { ref, expectedRevision };
}
/** Reads a money value out of a fact, a budget account, or any other `{ amountMinor }` payload. */
export function moneyMinor(value: unknown, label: string): number {
  if (value === null || typeof value !== "object" || !("amountMinor" in value) || typeof value.amountMinor !== "number") {
    throw new Error(`${label} is not a money value`);
  }
  return value.amountMinor;
}

/** Await a call that must reject, and return the contract error the client raised. */
export async function expectClientError(promise: Promise<unknown>): Promise<ContractClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ContractClientError) return error;
    throw error;
  }
  throw new Error("expected a ContractClientError");
}

/** Per-company references, read from the pack so tests never hardcode another company's IDs. */
export interface CompanyFixture {
  organizationId: string;
  requestId: string;
  commitmentId: string;
  budgetAccountId: string;
  requesterId: string;
  approverId: string;
  vendorId: string;
  categoryIds: string[];
  projectId: string | null;
  tenantScope: ScopeRef;
  departmentScope: ScopeRef;
  projectScope: ScopeRef | null;
  requestScopes: ScopeRef[];
}

export function companyFixture(pack: CompanyPack): CompanyFixture {
  const identity = pack.identity;
  const tenantScope: ScopeRef = { type: "organization", id: identity.organizationId };
  const departmentScope: ScopeRef = { type: "department", id: identity.department.id };
  const projectScope: ScopeRef | null = identity.project === null ? null : { type: "project", id: identity.project.id };
  return {
    organizationId: identity.organizationId,
    requestId: identity.requestId,
    commitmentId: identity.commitmentId,
    budgetAccountId: identity.budgetAccountId,
    requesterId: identity.requester.id,
    approverId: identity.approver.id,
    vendorId: identity.vendor.id,
    categoryIds: identity.categories.map((category) => category.id),
    projectId: identity.project?.id ?? null,
    tenantScope,
    departmentScope,
    projectScope,
    requestScopes: projectScope === null ? [tenantScope, departmentScope] : [tenantScope, departmentScope, projectScope],
  };
}
