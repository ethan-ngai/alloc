import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "@alloc/contracts";
import { createContractClient } from "@alloc/mock-api";
import { createMockApi, northstarPack } from "@alloc/mock-api/server";
import { ToolGateway, createReadOperationToolHandlers } from "../src/index.js";

const NOW = new Date("2026-09-12T14:02:00.000Z");

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    schemaVersion: "1.0.0",
    organizationId: "org_northstar",
    principalId: "employee_maya_chen",
    serviceIdentityId: "service_agent",
    authorityGrantRefs: [{ type: "authority_grant", id: "grant_read", revision: 1 }],
    allowedScopes: [
      { type: "organization", id: "org_northstar" },
      { type: "project", id: "project_beacon" },
    ],
    priority: "P0",
    jobId: "job_mock_investigation",
    leaseGeneration: 1,
    leaseExpiresAt: "2026-09-12T14:03:00.000Z",
    ...overrides,
  };
}

describe("contract operation tool adapter", () => {
  const api = createMockApi();
  let baseUrl = "";

  beforeEach(async () => {
    api.reset();
    baseUrl = (await api.listen(0)).url;
  });

  afterEach(async () => {
    await api.close();
  });

  function gateway() {
    const handlers = createReadOperationToolHandlers({
      createClient: (executionContext) => createContractClient({
        baseUrl,
        principalId: executionContext.principalId,
      }),
      authorizeSubject: (executionContext, subject) => (
        executionContext.organizationId === "org_northstar"
        && (subject.id === northstarPack.identity.requestId || subject.id === northstarPack.identity.project?.id)
      ),
    });
    return new ToolGateway(
      handlers,
      () => ({ allowedTools: ["get_request", "search_evidence"] }),
      { maxToolDurationMs: 10_000, clock: () => NOW },
    );
  }

  it("reads a current request through the real HTTP mock with injected identity", async () => {
    const response = await gateway().execute({
      name: "get_request",
      modelArguments: { requestId: "request_buffalo_trip" },
      executionContext: context(),
    });
    expect(response.current).toBe(true);
    expect(response.request).toMatchObject({
      organizationId: "org_northstar",
      requestId: "request_buffalo_trip",
      fullAmount: { amountMinor: 18_000, currency: "USD" },
    });
  });

  it("returns contract-shaped evidence restricted to the explicit scope and kind", async () => {
    const evidence = await gateway().execute({
      name: "search_evidence",
      modelArguments: {
        query: "travel",
        scopes: [{ type: "organization", id: "org_northstar" }],
        kinds: ["source_record"],
        page: { limit: 8 },
      },
      executionContext: context(),
    });
    expect(evidence.evidence).toHaveLength(1);
    expect(evidence.evidence[0]?.organizationId).toBe("org_northstar");
    expect(evidence.evidence.every(({ kind }) => kind === "source_record")).toBe(true);
  });

  it("denies a cross-company request before contacting the operation client", async () => {
    await expect(gateway().execute({
      name: "get_request",
      modelArguments: { requestId: "request_juniper_pos_rollout" },
      executionContext: context(),
    })).rejects.toEqual(expect.objectContaining({ code: "AUTHORITY_DENIED" }));
  });
});
