import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_MOCK_CLOCK } from "../src/clock.js";
import { COMPANY_IDENTITIES, northstarPack } from "../src/packs.js";
import {
  callOk, commandMeta, companyFixture, postOperation, queryMeta, requestJson, startMock, versionExpectation,
} from "./harness.js";

const company = companyFixture(northstarPack);

const HealthSchema = z.object({
  status: z.literal("ok"),
  schemaVersion: z.literal("1.0.0"),
  clock: z.string().min(1),
  organizations: z.array(z.string().min(1)),
  scenarioIds: z.record(z.string(), z.string()),
  provisional: z.literal(true),
});

const getRequest = {
  meta: queryMeta("correlation_protocol_get", company.organizationId),
  payload: { requestId: company.requestId },
};

describe("mock HTTP protocol", () => {
  it("answers CORS preflight and stamps CORS headers on operation and health responses", async () => {
    const { api, url } = await startMock();
    try {
      const preflight = await requestJson(url, "/operations/requests.get", { method: "OPTIONS" });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
      expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type, x-alloc-mock-principal, x-alloc-mock-fault");
      expect(preflight.headers.get("access-control-max-age")).toBe("600");

      const response = await postOperation(url, "requests.get", getRequest);
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);

      const health = await requestJson(url, "/health", { method: "GET" });
      expect(health.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      await api.close();
    }
  });

  it("reports health for every provisional organization at the logical clock start", async () => {
    const { api, url } = await startMock();
    try {
      const response = await requestJson(url, "/health", { method: "GET" });
      expect(response.status).toBe(200);
      const health = HealthSchema.parse(response.body);
      expect(health.clock).toBe(DEFAULT_MOCK_CLOCK);
      expect(health.organizations).toEqual(COMPANY_IDENTITIES.map((identity) => identity.organizationId));
      expect(health.scenarioIds).toEqual(
        Object.fromEntries(COMPANY_IDENTITIES.map((identity) => [identity.organizationId, identity.scenarioId])),
      );
      expect(health.provisional).toBe(true);
    } finally {
      await api.close();
    }
  });

  it("resets an organization back to its seeded revisions, commitment, and idempotency ledger", async () => {
    const { api, url } = await startMock();
    try {
      const amend = {
        meta: commandMeta("command_protocol_amend", "correlation_protocol_amend", company.organizationId, [
          versionExpectation({ type: "request", id: company.requestId }, 1),
        ]),
        payload: {
          requestId: company.requestId,
          revisedFullAmount: { amountMinor: 21_000, currency: "USD" },
          reason: "Protocol reset probe",
        },
      };
      await callOk(url, "requests.amend", amend);
      const amended = await callOk(url, "requests.get", { ...getRequest, meta: queryMeta("correlation_protocol_before", company.organizationId) });
      expect(amended.data.request.revision).toBe(2);
      expect(amended.data.commitment?.outstandingAmount.amountMinor).toBe(21_000);

      const reset = await requestJson(url, "/admin/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: company.organizationId }),
      });
      expect(reset.status).toBe(200);
      expect(JSON.stringify(reset.body)).toContain(company.organizationId);

      const restored = await callOk(url, "requests.get", { ...getRequest, meta: queryMeta("correlation_protocol_after", company.organizationId) });
      expect(restored.data.request.revision).toBe(1);
      expect(restored.data.decisions).toHaveLength(1);
      expect(restored.data.commitment?.outstandingAmount.amountMinor).toBe(18_000);

      // The cleared ledger means the same command ID now applies again instead of replaying.
      await callOk(url, "requests.amend", amend);
      const reapplied = await callOk(url, "requests.get", { ...getRequest, meta: queryMeta("correlation_protocol_reapplied", company.organizationId) });
      expect(reapplied.data.request.revision).toBe(2);
      expect(reapplied.data.commitment?.outstandingAmount.amountMinor).toBe(21_000);

      const unknown = await requestJson(url, "/admin/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org_protocol_missing" }),
      });
      expect(unknown.status).toBe(404);
      expect(JSON.stringify(unknown.body)).toContain("NOT_FOUND");
    } finally {
      await api.close();
    }
  });

  it("rejects a request body larger than one mebibyte with VALIDATION_FAILED", async () => {
    const { api, url } = await startMock();
    try {
      const body = JSON.stringify({
        meta: queryMeta("correlation_protocol_large", company.organizationId),
        payload: { requestId: company.requestId, filler: "x".repeat(1_100_000) },
      });
      const response = await requestJson(url, "/operations/requests.get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
      const serialized = JSON.stringify(response.body);
      expect(serialized).toContain("VALIDATION_FAILED");
      expect(serialized).toContain("requestBodyTooLarge");
    } finally {
      await api.close();
    }
  });
});
