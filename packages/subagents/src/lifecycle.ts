import type { ToolName } from "@alloc/contracts";
import {
  ChildRuntimeRecordSchema,
  type ChildRuntimeRecord,
  type ChildTask,
} from "./schemas.js";

export type ChildLifecycleErrorCode =
  | "CHILD_NOT_ACTIVE"
  | "CHILD_EXPIRED"
  | "TOOL_NOT_PERMITTED"
  | "TOOL_BUDGET_EXHAUSTED";

export class ChildLifecycleError extends Error {
  constructor(readonly code: ChildLifecycleErrorCode, message: string) {
    super(message);
    this.name = "ChildLifecycleError";
  }
}

export function createChildRuntimeRecord(task: ChildTask): ChildRuntimeRecord {
  return ChildRuntimeRecordSchema.parse({
    task,
    state: "admitted",
    toolCallsUsed: 0,
    detachedAt: null,
    terminatedAt: null,
  });
}

export function startChild(record: ChildRuntimeRecord, now: Date): ChildRuntimeRecord {
  const current = ChildRuntimeRecordSchema.parse(record);
  assertUsable(current, now);
  if (current.state !== "admitted") {
    throw new ChildLifecycleError("CHILD_NOT_ACTIVE", `cannot start child in ${current.state} state`);
  }
  return ChildRuntimeRecordSchema.parse({ ...current, state: "running" });
}

export function consumeChildToolCall(
  record: ChildRuntimeRecord,
  tool: ToolName,
  now: Date,
): ChildRuntimeRecord {
  const current = ChildRuntimeRecordSchema.parse(record);
  assertUsable(current, now);
  if (!current.task.permittedTools.includes(tool)) {
    throw new ChildLifecycleError("TOOL_NOT_PERMITTED", `${tool} is outside child authority`);
  }
  if (current.toolCallsUsed >= current.task.toolCallBudget) {
    throw new ChildLifecycleError("TOOL_BUDGET_EXHAUSTED", "child tool-call budget is exhausted");
  }
  return ChildRuntimeRecordSchema.parse({
    ...current,
    toolCallsUsed: current.toolCallsUsed + 1,
  });
}

export function terminateChild(
  record: ChildRuntimeRecord,
  outcome: "completed" | "failed" | "canceled",
  now: Date,
): ChildRuntimeRecord {
  const current = ChildRuntimeRecordSchema.parse(record);
  assertUsable(current, now);
  return ChildRuntimeRecordSchema.parse({
    ...current,
    state: outcome,
    terminatedAt: now.toISOString(),
  });
}

export function applyParentTermination(
  record: ChildRuntimeRecord,
  disposition: "cancel" | "detach",
  now: Date,
): ChildRuntimeRecord {
  const current = ChildRuntimeRecordSchema.parse(record);
  if (!isActive(current.state)) return current;

  if (disposition === "cancel") {
    return ChildRuntimeRecordSchema.parse({
      ...current,
      state: "canceled",
      terminatedAt: now.toISOString(),
    });
  }

  return ChildRuntimeRecordSchema.parse({
    ...current,
    state: "detached",
    detachedAt: now.toISOString(),
  });
}

function isActive(state: ChildRuntimeRecord["state"]): boolean {
  return state === "admitted" || state === "running" || state === "detached";
}

function assertUsable(record: ChildRuntimeRecord, now: Date): void {
  if (!isActive(record.state)) {
    throw new ChildLifecycleError("CHILD_NOT_ACTIVE", `child is in ${record.state} state`);
  }
  if (now.getTime() >= Date.parse(record.task.expiresAt)) {
    throw new ChildLifecycleError("CHILD_EXPIRED", "child deadline has expired");
  }
}
