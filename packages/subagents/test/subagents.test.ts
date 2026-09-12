import { describe, expect, it } from "vitest";
import {
  SingleInferenceSlot,
  admitChildTask,
  applyParentTermination,
  consumeChildToolCall,
  createChildRuntimeRecord,
  mergeChildResults,
  selectNextInference,
  startChild,
  terminateChild,
  validateChildResult,
  type ChildDelegationRequest,
  type ChildResult,
  type ChildRolePolicy,
  type ChildTask,
  type ParentDelegationAuthority,
} from "../src/index.js";

const NOW = new Date("2026-09-12T16:00:00.000Z");

function parent(overrides: Partial<ParentDelegationAuthority> = {}): ParentDelegationAuthority {
  return {
    schemaVersion: "1.0.0",
    organizationId: "org_northstar",
    parentJobId: "job_investigation",
    parentServiceIdentityId: "service_coordinator",
    leaseGeneration: 3,
    leaseExpiresAt: "2026-09-12T16:10:00.000Z",
    delegationDepth: 0,
    priority: "P0",
    allowedScopes: [
      { type: "organization", id: "org_northstar" },
      { type: "project", id: "project_atlas" },
    ],
    permittedTools: ["get_context", "search_evidence", "run_forecast"],
    evidenceCutoff: "2026-09-12T15:59:00.000Z",
    ...overrides,
  };
}

function policy(overrides: Partial<ChildRolePolicy> = {}): ChildRolePolicy {
  return {
    role: "project_investigator",
    maximumPriority: "P1",
    allowedScopes: [{ type: "project", id: "project_atlas" }],
    permittedTools: ["get_context", "search_evidence"],
    maximumLifetimeMs: 120_000,
    maximumToolCalls: 8,
    maximumOutputBytes: 8_000,
    maximumContextTokens: 4_000,
    ...overrides,
  };
}

function request(overrides: Partial<ChildDelegationRequest> = {}): ChildDelegationRequest {
  return {
    role: "project_investigator",
    objective: "Find the current Atlas milestone and cite its versioned evidence.",
    requestedScopes: [
      { type: "project", id: "project_atlas" },
      { type: "organization", id: "org_other" },
    ],
    requestedTools: ["get_context", "search_evidence", "run_forecast"],
    requestedExpiresAt: "2026-09-12T16:05:00.000Z",
    requestedToolCalls: 12,
    requestedOutputBytes: 20_000,
    requestedContextTokens: 8_000,
    ...overrides,
  };
}

function admit(overrides: Partial<Parameters<typeof admitChildTask>[0]> = {}): ChildTask {
  return admitChildTask({
    parent: parent(),
    rolePolicy: policy(),
    request: request(),
    identity: {
      childTaskId: "child_atlas",
      childServiceIdentityId: "service_child_atlas",
    },
    activeChildTaskIds: [],
    now: NOW,
    ...overrides,
  }).task;
}

function result(task: ChildTask, overrides: Partial<ChildResult> = {}): ChildResult {
  return {
    schemaVersion: "1.0.0",
    organizationId: task.organizationId,
    childTaskId: task.childTaskId,
    parentJobId: task.parentJobId,
    parentLeaseGeneration: task.parentLeaseGeneration,
    completion: "completed",
    claims: [{
      claimKey: "atlas.milestone",
      value: "beta",
      statement: "Atlas is at the beta milestone.",
      evidenceRefs: [{ type: "evidence", id: "evidence_atlas", revision: 2 }],
      calculatedResultRefs: [],
    }],
    missingContext: [],
    coverage: { inspectedRecords: 4, truncated: false },
    completedAt: "2026-09-12T16:01:00.000Z",
    ...overrides,
  };
}

const allowedEvidence = new Set(["evidence\u0000evidence_atlas\u00002"]);

describe("delegation admission", () => {
  it("intersects authority and clamps priority, expiry, and resource budgets", () => {
    const admitted = admitChildTask({
      parent: parent(), rolePolicy: policy(), request: request(),
      identity: { childTaskId: "child_atlas", childServiceIdentityId: "service_child_atlas" },
      activeChildTaskIds: [], now: NOW,
    });
    expect(admitted.task).toMatchObject({
      priority: "P1",
      allowedScopes: [{ type: "project", id: "project_atlas" }],
      permittedTools: ["get_context", "search_evidence"],
      admittedAt: "2026-09-12T16:00:00.000Z",
      expiresAt: "2026-09-12T16:02:00.000Z",
      toolCallBudget: 8,
      outputByteBudget: 8_000,
      contextTokenBudget: 4_000,
      delegationDepth: 1,
    });
    expect(admitted.deniedScopes).toEqual([{ type: "organization", id: "org_other" }]);
    expect(admitted.deniedTools).toEqual(["run_forecast"]);
  });

  it("denies recursive delegation and a third active child", () => {
    expect(() => admit({ parent: parent({ delegationDepth: 1 }) })).toThrowError(
      expect.objectContaining({ code: "RECURSIVE_DELEGATION_DENIED" }),
    );
    expect(() => admit({ activeChildTaskIds: ["child_one", "child_two"] })).toThrowError(
      expect.objectContaining({ code: "CHILD_LIMIT_REACHED" }),
    );
  });

  it("fails closed when no requested scope or tool survives intersection", () => {
    expect(() => admit({
      request: request({ requestedScopes: [{ type: "project", id: "project_other" }] }),
    })).toThrowError(expect.objectContaining({ code: "NO_AUTHORIZED_SCOPE" }));
    expect(() => admit({
      request: request({ requestedTools: ["run_forecast"] }),
    })).toThrowError(expect.objectContaining({ code: "NO_AUTHORIZED_TOOL" }));
  });

  it("canonicalizes duplicate requested scopes and tools", () => {
    const task = admit({
      request: request({
        requestedScopes: [
          { type: "project", id: "project_atlas" },
          { type: "project", id: "project_atlas" },
        ],
        requestedTools: ["get_context", "get_context"],
      }),
    });
    expect(task.allowedScopes).toEqual([{ type: "project", id: "project_atlas" }]);
    expect(task.permittedTools).toEqual(["get_context"]);
  });

  it("always removes proposal submission from child authority", () => {
    expect(() => admit({
      parent: parent({ permittedTools: ["propose_action"] }),
      rolePolicy: policy({ permittedTools: ["propose_action"] }),
      request: request({ requestedTools: ["propose_action"] }),
    })).toThrowError(expect.objectContaining({ code: "NO_AUTHORIZED_TOOL" }));

    const admitted = admit({
      parent: parent({ permittedTools: ["get_context", "propose_action"] }),
      rolePolicy: policy({ permittedTools: ["get_context", "propose_action"] }),
      request: request({ requestedTools: ["get_context", "propose_action"] }),
    });
    expect(admitted.permittedTools).toEqual(["get_context"]);
  });
});

describe("child lifecycle", () => {
  it("counts authorized tool calls and enforces the admitted budget", () => {
    const task = admit({
      rolePolicy: policy({ maximumToolCalls: 1 }),
      request: request({ requestedToolCalls: 1 }),
    });
    const running = startChild(createChildRuntimeRecord(task), NOW);
    const used = consumeChildToolCall(running, "get_context", NOW);
    expect(used.toolCallsUsed).toBe(1);
    expect(() => consumeChildToolCall(used, "get_context", NOW)).toThrowError(
      expect.objectContaining({ code: "TOOL_BUDGET_EXHAUSTED" }),
    );
    expect(() => consumeChildToolCall(running, "run_forecast", NOW)).toThrowError(
      expect.objectContaining({ code: "TOOL_NOT_PERMITTED" }),
    );
  });

  it("cancels active children when the parent chooses cancel", () => {
    const running = startChild(createChildRuntimeRecord(admit()), NOW);
    const canceled = applyParentTermination(running, "cancel", NOW);
    expect(canceled).toMatchObject({
      state: "canceled",
      terminatedAt: NOW.toISOString(),
      detachedAt: null,
    });
    expect(() => consumeChildToolCall(canceled, "get_context", NOW)).toThrowError(
      expect.objectContaining({ code: "CHILD_NOT_ACTIVE" }),
    );
  });

  it("detaches active children with their original read-only authority and deadline", () => {
    const task = admit({
      parent: parent({ permittedTools: ["get_context", "propose_action"] }),
      rolePolicy: policy({ permittedTools: ["get_context", "propose_action"] }),
      request: request({ requestedTools: ["get_context", "propose_action"] }),
    });
    const detached = applyParentTermination(createChildRuntimeRecord(task), "detach", NOW);
    expect(detached.state).toBe("detached");
    expect(detached.task.expiresAt).toBe(task.expiresAt);
    expect(detached.task.permittedTools).toEqual(["get_context"]);
    expect(consumeChildToolCall(detached, "get_context", NOW).toolCallsUsed).toBe(1);
    expect(() => consumeChildToolCall(detached, "propose_action", NOW)).toThrowError(
      expect.objectContaining({ code: "TOOL_NOT_PERMITTED" }),
    );
  });

  it("rejects work at the deadline and does not rewrite terminal children", () => {
    const task = admit();
    const running = startChild(createChildRuntimeRecord(task), NOW);
    expect(() => consumeChildToolCall(running, "get_context", new Date(task.expiresAt))).toThrowError(
      expect.objectContaining({ code: "CHILD_EXPIRED" }),
    );
    const completed = terminateChild(running, "completed", new Date("2026-09-12T16:01:00.000Z"));
    expect(applyParentTermination(completed, "cancel", NOW)).toEqual(completed);
  });
});

describe("result validation and merging", () => {
  it("accepts versioned in-scope evidence for the current parent lease", () => {
    const task = admit();
    const validated = validateChildResult({
      task,
      result: result(task),
      parent: { organizationId: task.organizationId, parentJobId: task.parentJobId, leaseGeneration: 3 },
      allowedEvidenceRefs: allowedEvidence,
    });
    expect(validated.encodedBytes).toBeGreaterThan(0);
  });

  it("rejects stale parents, late output, and out-of-scope evidence", () => {
    const task = admit();
    const base = {
      task,
      result: result(task),
      parent: { organizationId: task.organizationId, parentJobId: task.parentJobId, leaseGeneration: 3 },
      allowedEvidenceRefs: allowedEvidence,
    };
    expect(() => validateChildResult({
      ...base,
      parent: { ...base.parent, leaseGeneration: 4 },
    })).toThrowError(expect.objectContaining({ code: "STALE_PARENT_LEASE" }));
    expect(() => validateChildResult({
      ...base,
      result: result(task, { completedAt: task.expiresAt.replace("02:00", "03:00") }),
    })).toThrowError(expect.objectContaining({ code: "RESULT_EXPIRED" }));
    expect(() => validateChildResult({ ...base, allowedEvidenceRefs: new Set() })).toThrowError(
      expect.objectContaining({ code: "EVIDENCE_OUT_OF_SCOPE" }),
    );
  });

  it("rejects output timestamped before admission", () => {
    const task = admit();
    expect(() => validateChildResult({
      task,
      result: result(task, { completedAt: "2026-09-12T15:59:59.000Z" }),
      parent: { organizationId: task.organizationId, parentJobId: task.parentJobId, leaseGeneration: 3 },
      allowedEvidenceRefs: allowedEvidence,
    })).toThrowError(expect.objectContaining({ code: "RESULT_EXPIRED" }));
  });

  it("measures serialized output instead of trusting a child size claim", () => {
    const task = admit({
      rolePolicy: policy({ maximumOutputBytes: 256 }),
      request: request({ requestedOutputBytes: 256 }),
    });
    expect(() => validateChildResult({
      task,
      result: result(task),
      parent: { organizationId: task.organizationId, parentJobId: task.parentJobId, leaseGeneration: 3 },
      allowedEvidenceRefs: allowedEvidence,
    })).toThrowError(expect.objectContaining({ code: "RESULT_TOO_LARGE" }));
  });

  it("keeps conflicting child claims visible and reports missing coverage", () => {
    const firstTask = admit();
    const secondTask = admit({
      identity: { childTaskId: "child_spending", childServiceIdentityId: "service_child_spending" },
    });
    const currentParent = {
      organizationId: firstTask.organizationId,
      parentJobId: firstTask.parentJobId,
      leaseGeneration: 3,
    };
    const first = validateChildResult({
      task: firstTask, result: result(firstTask), parent: currentParent, allowedEvidenceRefs: allowedEvidence,
    });
    const second = validateChildResult({
      task: secondTask,
      result: result(secondTask, {
        claims: [{
          claimKey: "atlas.milestone",
          value: "production",
          statement: "A second source labels Atlas production-ready.",
          evidenceRefs: [{ type: "evidence", id: "evidence_atlas", revision: 2 }],
          calculatedResultRefs: [],
        }],
        completion: "partial",
        missingContext: ["deployment approval"],
        coverage: { inspectedRecords: 2, truncated: true },
      }),
      parent: currentParent,
      allowedEvidenceRefs: allowedEvidence,
    });
    const merged = mergeChildResults([firstTask, secondTask], [second, first]);
    expect(merged.completion).toBe("partial");
    expect(merged.conflicts).toEqual([{
      claimKey: "atlas.milestone",
      values: ["beta", "production"],
      childTaskIds: ["child_atlas", "child_spending"],
    }]);
    expect(merged.missingContext).toEqual(["deployment approval"]);
    expect(merged.coverage).toEqual({ inspectedRecords: 6, truncated: true });
  });
});

describe("global inference admission", () => {
  const background = {
    requestId: "inference_child",
    jobId: "job_investigation",
    childTaskId: "child_atlas",
    priority: "P1" as const,
    queuedAt: "2026-09-12T16:00:00.000Z",
  };
  const urgent = {
    requestId: "inference_urgent",
    jobId: "job_urgent",
    childTaskId: null,
    priority: "P0" as const,
    queuedAt: "2026-09-12T16:00:01.000Z",
  };

  it("gives the next free slot to urgent work ahead of pending children", () => {
    expect(selectNextInference([background, urgent])?.requestId).toBe("inference_urgent");
  });

  it("does not claim that a running generation can be preempted", () => {
    const slot = new SingleInferenceSlot();
    expect(slot.acquire(background)).toBe(true);
    expect(slot.acquire(urgent)).toBe(false);
    expect(slot.active?.requestId).toBe("inference_child");
    slot.release("inference_child");
    expect(slot.acquire(selectNextInference([urgent])!)).toBe(true);
    expect(slot.active?.requestId).toBe("inference_urgent");
  });
});
