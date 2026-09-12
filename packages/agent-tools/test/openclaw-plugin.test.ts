import type { ToolExecutionContext, ToolResult } from "@alloc/contracts";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { describe, expect, it, vi } from "vitest";
import {
  ALLOC_BINDING_KEY,
  ToolGateway,
  allocToolDefinition,
  createAllocToolPlugin,
  readBinding,
  type AllocToolPluginOptions,
  type ToolHandlers,
} from "../src/index.js";

const NOW = new Date("2026-09-12T16:00:00.000Z");
const BINDING = { jobId: "job_investigation", leaseGeneration: 1 };
const BOUND_CONTEXT = { toolBindings: { [ALLOC_BINDING_KEY]: BINDING } };

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    schemaVersion: "1.0.0",
    organizationId: "org_northstar",
    principalId: "principal_eric",
    serviceIdentityId: "service_agent",
    authorityGrantRefs: [{ type: "authority_grant", id: "grant_read", revision: 1 }],
    allowedScopes: [{ type: "organization", id: "org_northstar" }],
    priority: "P0",
    jobId: "job_investigation",
    leaseGeneration: 1,
    leaseExpiresAt: "2026-09-12T16:01:00.000Z",
    ...overrides,
  };
}

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

const REQUEST = {
  schemaVersion: "1.0.0",
  organizationId: "org_northstar",
  requestId: "request_buffalo_trip",
  revision: 1,
  previousRevision: null,
  requesterId: "employee_maya_chen",
  purpose: "Buffalo Beacon pilot trip",
  fullAmount: usd(18_000),
  increaseFromPrevious: usd(0),
  cumulativeIncrease: usd(0),
  categoryId: "category_travel",
  vendorId: "vendor_buffalo_hotel",
  projectId: "project_beacon",
  scopes: [{ type: "organization", id: "org_northstar" }],
  evaluationState: "approved",
  submittedAt: "2026-09-12T14:00:00Z",
  provenance: {
    kind: "synthetic",
    trust: "authoritative",
    sourceInstanceId: "source_northstar_simulator",
    sourceObjectId: "buffalo-trip-request",
    sourceRevision: "1",
    occurredAt: "2026-09-12T14:00:00Z",
    observedAt: "2026-09-12T14:00:00Z",
  },
} as const;

const REQUEST_RESULT = { request: REQUEST, current: true } as unknown as ToolResult<"get_request">;

function options(overrides: Partial<AllocToolPluginOptions> = {}): AllocToolPluginOptions {
  const handlers: ToolHandlers = {
    get_request: { authorize: () => true, execute: async () => REQUEST_RESULT },
  };
  return {
    gateway: new ToolGateway(
      handlers,
      () => ({ allowedTools: ["get_request"] }),
      { maxToolDurationMs: 30_000, clock: () => NOW },
    ),
    resolveExecutionContext: async () => context(),
    tools: ["get_request"],
    ...overrides,
  };
}

describe("Alloc OpenClaw tool plugin", () => {
  it("publishes contract-derived manifest metadata for the exposed tools", () => {
    const metadata = getToolPluginMetadata(createAllocToolPlugin(options()));
    expect(metadata?.id).toBe("alloc-financial-tools");
    expect(metadata?.tools.map(({ name }) => name)).toEqual(["get_request"]);
    // The model-facing schema is the 1A contract, not a hand-written copy.
    expect(metadata?.tools[0]?.parameters).toMatchObject({
      properties: { requestId: expect.anything() },
      required: ["requestId"],
    });
  });

  it("reads job identity only from the trusted run bindings", () => {
    expect(readBinding(BOUND_CONTEXT)).toEqual(BINDING);
    expect(readBinding({})).toBeNull();
    expect(readBinding({ toolBindings: {} })).toBeNull();
    expect(readBinding({ toolBindings: { [ALLOC_BINDING_KEY]: { jobId: "" } } })).toBeNull();
    expect(
      readBinding({ toolBindings: { [ALLOC_BINDING_KEY]: { ...BINDING, organizationId: "org_other" } } }),
    ).toBeNull();
  });

  it("exposes no tool to a run that carries no Alloc binding", () => {
    const definition = allocToolDefinition("get_request", options());
    expect(definition.factory({ toolContext: {} })).toBeNull();
    expect(definition.factory({ toolContext: { toolBindings: { other: BINDING } } })).toBeNull();
    expect(definition.factory({ toolContext: BOUND_CONTEXT })).not.toBeNull();
  });

  it("resolves authority per call rather than freezing it into the run", async () => {
    const resolveExecutionContext = vi.fn(async (_binding: unknown) => context());
    const definition = allocToolDefinition("get_request", options({ resolveExecutionContext }));
    const tool = definition.factory({ toolContext: BOUND_CONTEXT });
    expect(resolveExecutionContext).not.toHaveBeenCalled();

    const result = await tool!.execute("call_1", { requestId: REQUEST.requestId });
    await tool!.execute("call_2", { requestId: REQUEST.requestId });

    expect(resolveExecutionContext).toHaveBeenCalledTimes(2);
    expect(resolveExecutionContext.mock.calls[0]?.[0]).toEqual(BINDING);
    expect(result.details).toEqual(REQUEST_RESULT);
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("ignores identity fields a model tries to smuggle through tool arguments", async () => {
    const resolveExecutionContext = vi.fn(async (_binding: unknown) => context());
    const definition = allocToolDefinition("get_request", options({ resolveExecutionContext }));
    const tool = definition.factory({ toolContext: BOUND_CONTEXT })!;

    // Strict contract parsing rejects the extra keys outright.
    await expect(tool.execute("call_hostile", {
      requestId: REQUEST.requestId,
      organizationId: "org_other",
      jobId: "job_elevated",
    })).rejects.toEqual(expect.objectContaining({ code: "INVALID_ARGUMENTS" }));

    // The identity actually used still came from the binding, never the arguments.
    expect(resolveExecutionContext.mock.calls[0]?.[0]).toEqual(BINDING);
  });

  it("refuses a call once the job lease has expired", async () => {
    const definition = allocToolDefinition("get_request", options({
      resolveExecutionContext: async () => context({ leaseExpiresAt: "2026-09-12T15:59:00.000Z" }),
    }));
    const tool = definition.factory({ toolContext: BOUND_CONTEXT })!;
    await expect(tool.execute("call_stale", { requestId: REQUEST.requestId })).rejects.toEqual(
      expect.objectContaining({ code: "LEASE_EXPIRED" }),
    );
  });

  it("refuses a tool the backend allowlist does not grant", async () => {
    const definition = allocToolDefinition("get_request", options({
      gateway: new ToolGateway(
        { get_request: { authorize: () => true, execute: async () => REQUEST_RESULT } },
        () => ({ allowedTools: [] }),
        { maxToolDurationMs: 30_000, clock: () => NOW },
      ),
    }));
    const tool = definition.factory({ toolContext: BOUND_CONTEXT })!;
    await expect(tool.execute("call_denied", { requestId: REQUEST.requestId })).rejects.toEqual(
      expect.objectContaining({ code: "TOOL_NOT_ALLOWED" }),
    );
  });
});
