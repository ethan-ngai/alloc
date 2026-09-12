import { IdSchema, PurchaseRequestRevisionSchema, type PurchaseRequestRevision } from "@alloc/contracts";
import { describe, expect, it } from "vitest";
import { requestBudgetScopes, scopeKey } from "../../src/finance/budgets.js";
import { financeErrors } from "../../src/finance/errors.js";
import { fingerprint, recordId } from "../../src/finance/ids.js";
import { buildTestApp, signTestToken } from "../support/app.js";
import { financeStub } from "../support/finance.js";

const ORGANIZATION_ID = "org_northstar";

function revision(): PurchaseRequestRevision {
  return PurchaseRequestRevisionSchema.parse({
    schemaVersion: "1.0.0",
    organizationId: ORGANIZATION_ID,
    requestId: "request_finance_unit",
    revision: 1,
    previousRevision: null,
    requesterId: "employee_maya_chen",
    purpose: "Buffalo Beacon pilot trip",
    fullAmount: { amountMinor: 18_000, currency: "USD" },
    increaseFromPrevious: { amountMinor: 0, currency: "USD" },
    cumulativeIncrease: { amountMinor: 0, currency: "USD" },
    categoryId: "category_travel",
    vendorId: "vendor_buffalo_hotel",
    projectId: "project_beacon",
    scopes: [
      { type: "organization", id: ORGANIZATION_ID },
      { type: "department", id: "department_field_engineering" },
      { type: "project", id: "project_beacon" },
    ],
    evaluationState: "approved",
    submittedAt: "2026-09-12T14:00:00Z",
    provenance: {
      kind: "synthetic", trust: "authoritative", sourceInstanceId: "source_api_command",
      sourceObjectId: "request_finance_unit-submission", sourceRevision: "1",
      occurredAt: "2026-09-12T14:00:00Z", observedAt: "2026-09-12T14:00:00Z",
    },
  });
}

function createBody(commandId = "command_unit_create") {
  return {
    meta: { schemaVersion: "1.0.0", organizationId: ORGANIZATION_ID, commandId, correlationId: "correlation_unit", expectedVersions: [] },
    payload: {
      requesterId: "employee_maya_chen",
      purpose: "Buffalo Beacon pilot trip",
      fullAmount: { amountMinor: 18_000, currency: "USD" },
      categoryId: "category_travel",
      vendorId: "vendor_buffalo_hotel",
      projectId: "project_beacon",
      scopes: [
        { type: "organization", id: ORGANIZATION_ID },
        { type: "department", id: "department_field_engineering" },
      ],
    },
  };
}

describe("finance ids", () => {
  it("fingerprints by meaning, not property order", () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  it("derives deterministic, contract-valid record ids", () => {
    const first = recordId("request", ORGANIZATION_ID, "command_unit_create");
    expect(first).toBe(recordId("request", ORGANIZATION_ID, "command_unit_create"));
    expect(first).not.toBe(recordId("request", ORGANIZATION_ID, "command_other"));
    expect(IdSchema.safeParse(first).success).toBe(true);
  });
});

describe("binding budget scopes", () => {
  it("adds category, employee, vendor, and project dimensions to request scopes", () => {
    const keys = requestBudgetScopes(revision()).map(scopeKey);
    expect(keys).toContain(scopeKey({ type: "category", id: "category_travel" }));
    expect(keys).toContain(scopeKey({ type: "employee", id: "employee_maya_chen" }));
    expect(keys).toContain(scopeKey({ type: "vendor", id: "vendor_buffalo_hotel" }));
    expect(keys).toContain(scopeKey({ type: "project", id: "project_beacon" }));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("finance routes", () => {
  it("rejects an unauthenticated create with the shared error contract", async () => {
    const { app } = buildTestApp({ finance: financeStub({}) });
    const response = await app.inject({ method: "POST", url: `/v1/organizations/${ORGANIZATION_ID}/requests`, payload: createBody() });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "ACCESS_DENIED" } });
    await app.close();
  });

  it("rejects a token whose tenant does not match the path", async () => {
    const { app } = buildTestApp({ finance: financeStub({}) });
    const token = await signTestToken({ claims: { org: "org_juniper" } });
    const response = await app.inject({
      method: "POST", url: `/v1/organizations/${ORGANIZATION_ID}/requests`, payload: createBody(),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("creates a request with the authenticated tenant and returns the revision", async () => {
    let capturedOrganization: string | undefined;
    const { app } = buildTestApp({
      finance: financeStub({
        async createRequest(_context, input) {
          capturedOrganization = input.meta.organizationId;
          return revision();
        },
      }),
    });
    const token = await signTestToken({ claims: { sub: "employee_maya_chen", roles: ["employee"] } });
    const response = await app.inject({
      method: "POST", url: `/v1/organizations/${ORGANIZATION_ID}/requests`, payload: createBody(),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, data: { requestId: "request_finance_unit", evaluationState: "approved" } });
    expect(capturedOrganization).toBe(ORGANIZATION_ID);
    await app.close();
  });

  it("rejects an amendment whose payload names a different request", async () => {
    const { app } = buildTestApp({ finance: financeStub({}) });
    const token = await signTestToken({ claims: { sub: "employee_maya_chen", roles: ["employee"] } });
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${ORGANIZATION_ID}/requests/request_one/amendments`,
      payload: {
        meta: {
          schemaVersion: "1.0.0", organizationId: ORGANIZATION_ID, commandId: "command_unit_amend", correlationId: "correlation_unit",
          expectedVersions: [{ ref: { type: "request", id: "request_one" }, expectedRevision: 1 }],
        },
        payload: { requestId: "request_two", revisedFullAmount: { amountMinor: 21_000, currency: "USD" }, reason: "More lodging" },
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("maps a finance authority failure onto AUTHORITY_DENIED", async () => {
    const { app } = buildTestApp({
      finance: financeStub({
        async decideReview() { throw financeErrors.authorityDenied("finance manager required"); },
      }),
    });
    const token = await signTestToken({ claims: { sub: "employee_avery_finance", roles: ["finance_manager"] } });
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${ORGANIZATION_ID}/requests/request_one/reviews`,
      payload: {
        meta: {
          schemaVersion: "1.0.0", organizationId: ORGANIZATION_ID, commandId: "command_unit_review", correlationId: "correlation_unit",
          expectedVersions: [],
        },
        payload: { requestId: "request_one", requestRevision: 1, outcome: "approved", rationale: "Looks fine" },
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "AUTHORITY_DENIED" } });
    await app.close();
  });

  it("returns 404 for an unknown request and does not search another tenant", async () => {
    let requested: string[] = [];
    const { app } = buildTestApp({
      finance: financeStub({
        async getRequest(organizationId, requestId) { requested.push(`${organizationId}/${requestId}`); return null; },
      }),
    });
    const token = await signTestToken({ claims: { sub: "employee_maya_chen", roles: ["employee"] } });
    const response = await app.inject({
      method: "GET", url: `/v1/organizations/${ORGANIZATION_ID}/requests/request_missing`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    expect(requested).toEqual([`${ORGANIZATION_ID}/request_missing`]);
    await app.close();
  });

  it("rejects query parameters on request reads", async () => {
    const { app } = buildTestApp({ finance: financeStub({}) });
    const token = await signTestToken({ claims: { sub: "employee_maya_chen", roles: ["employee"] } });
    const response = await app.inject({
      method: "GET", url: `/v1/organizations/${ORGANIZATION_ID}/requests/request_one?debug=1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
