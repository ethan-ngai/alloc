import { CompanyEntitySchema, operationResult } from "@alloc/contracts";
import type { FastifyInstance } from "fastify";
import { MongoNetworkError } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";
import type { OrganizationRepository } from "../../src/mongo/organizations.js";
import { buildTestApp, recordingRepository, signTestToken, type RecordingRepository } from "../support/app.js";
import { juniperOrganizationId, NORTHSTAR_ORGANIZATION_ID, northstarOrganization } from "../support/organizations.js";

const OrganizationResultSchema = operationResult(CompanyEntitySchema);
const ORGANIZATION_URL = `/v1/organizations/${NORTHSTAR_ORGANIZATION_ID}`;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("GET /v1/organizations/:organizationId", () => {
  it("returns the organization inside the shared operation-result envelope", async () => {
    const { app, organizations } = newTestApp();
    const response = await app.inject({
      method: "GET",
      url: ORGANIZATION_URL,
      headers: { authorization: `Bearer ${await signTestToken()}` },
    });

    expect(response.statusCode).toBe(200);
    const parsed = OrganizationResultSchema.parse(response.json());
    expect(parsed).toMatchObject({ ok: true, correlationId: response.headers["x-correlation-id"] });
    if (!parsed.ok) {
      throw new Error("expected a successful envelope");
    }
    expect(parsed.data).toEqual(northstarOrganization);
    expect(organizations.requestedIds).toEqual([NORTHSTAR_ORGANIZATION_ID]);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects a malformed organization ID before any lookup", async () => {
    const { app, organizations } = newTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/organizations/NotAnOrganizationId",
      headers: { authorization: `Bearer ${await signTestToken()}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED", retryable: false } });
    expect(organizations.requestedIds).toEqual([]);
  });

  it("rejects unexpected query parameters", async () => {
    const { app, organizations } = newTestApp();
    const response = await app.inject({
      method: "GET",
      url: `${ORGANIZATION_URL}?include=budgets`,
      headers: { authorization: `Bearer ${await signTestToken()}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(organizations.requestedIds).toEqual([]);
  });

  it("returns 403 for a token from another organization and never searches that tenant", async () => {
    const { app, organizations } = newTestApp();
    const token = await signTestToken({ claims: { org: juniperOrganizationId } });
    const response = await app.inject({
      method: "GET",
      url: ORGANIZATION_URL,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "ACCESS_DENIED" } });
    expect(organizations.requestedIds).toEqual([]);
  });

  it("scopes the lookup to the verified organization claim", async () => {
    const { app, organizations } = newTestApp();
    const token = await signTestToken({ claims: { org: juniperOrganizationId } });
    const response = await app.inject({
      method: "GET",
      url: `/v1/organizations/${juniperOrganizationId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
    expect(organizations.requestedIds).toEqual([juniperOrganizationId]);
  });

  it("returns 404 for an organization that does not exist", async () => {
    const { app } = newTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/organizations/org_missing",
      headers: { authorization: `Bearer ${await signTestToken({ claims: { org: "org_missing" } })}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("maps a database outage to a retryable dependency error without driver detail", async () => {
    const app = newTestAppWith({
      findById: async () => {
        throw new MongoNetworkError("connection to 127.0.0.1:27017 timed out for mongodb://alloc:hunter2@127.0.0.1");
      },
    });
    const response = await app.inject({
      method: "GET",
      url: ORGANIZATION_URL,
      headers: { authorization: `Bearer ${await signTestToken()}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "DEPENDENCY_UNAVAILABLE", retryable: true } });
    expect(response.body).not.toContain("hunter2");
    expect(response.body).not.toContain("127.0.0.1");
  });

  it("maps an unexpected repository failure to a generic internal error", async () => {
    const app = newTestAppWith({
      findById: async () => {
        throw new Error("document did not match the contract at mongodb://alloc:hunter2@127.0.0.1");
      },
    });
    const response = await app.inject({
      method: "GET",
      url: ORGANIZATION_URL,
      headers: { authorization: `Bearer ${await signTestToken()}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Internal server error", retryable: false },
    });
    expect(response.body).not.toContain("hunter2");
    expect(response.body).not.toContain("document did not match");
  });
});

function newTestApp(): { app: FastifyInstance; organizations: RecordingRepository } {
  const organizations = recordingRepository([northstarOrganization]);
  const { app } = buildTestApp({ organizations });
  apps.push(app);
  return { app, organizations };
}

function newTestAppWith(organizations: OrganizationRepository): FastifyInstance {
  const { app } = buildTestApp({ organizations });
  apps.push(app);
  return app;
}
