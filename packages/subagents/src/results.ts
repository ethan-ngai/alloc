import {
  ChildResultSchema,
  ChildRuntimeRecordSchema,
  ChildTaskSchema,
  type ChildClaim,
  type ChildResult,
  type ChildRole,
  type ChildRuntimeRecord,
  type ChildTask,
} from "./schemas.js";

export type ChildResultErrorCode =
  | "TASK_MISMATCH"
  | "STALE_PARENT_LEASE"
  | "RESULT_EXPIRED"
  | "RESULT_TOO_LARGE"
  | "EVIDENCE_OUT_OF_SCOPE"
  | "CHILD_NOT_TERMINAL"
  | "RESULT_STATE_MISMATCH"
  | "DUPLICATE_CHILD_RESULT";

export class ChildResultError extends Error {
  constructor(readonly code: ChildResultErrorCode, message: string) {
    super(message);
    this.name = "ChildResultError";
  }
}

export interface CurrentParentState {
  organizationId: string;
  parentJobId: string;
  leaseGeneration: number;
}

export interface ValidatedChildResult {
  task: ChildTask;
  result: ChildResult;
  encodedBytes: number;
}

function referenceKey(reference: { type: string; id: string; revision: number }): string {
  return `${reference.type}\u0000${reference.id}\u0000${reference.revision}`;
}

export function validateChildResult(input: {
  runtimeRecord: ChildRuntimeRecord;
  result: ChildResult;
  parent: CurrentParentState;
  allowedEvidenceRefs: ReadonlySet<string>;
}): ValidatedChildResult {
  const runtimeRecord = ChildRuntimeRecordSchema.parse(input.runtimeRecord);
  const task = runtimeRecord.task;
  const result = ChildResultSchema.parse(input.result);
  if (
    runtimeRecord.state !== "completed"
    && runtimeRecord.state !== "failed"
    && runtimeRecord.state !== "canceled"
  ) {
    throw new ChildResultError("CHILD_NOT_TERMINAL", "child must reach a terminal lifecycle state first");
  }
  const completionMatches = runtimeRecord.state === "completed"
    ? result.completion === "completed" || result.completion === "partial"
    : result.completion === runtimeRecord.state;
  if (!completionMatches) {
    throw new ChildResultError("RESULT_STATE_MISMATCH", "result completion does not match child lifecycle state");
  }
  if (
    result.organizationId !== task.organizationId
    || result.childTaskId !== task.childTaskId
    || result.parentJobId !== task.parentJobId
    || input.parent.organizationId !== task.organizationId
    || input.parent.parentJobId !== task.parentJobId
  ) {
    throw new ChildResultError("TASK_MISMATCH", "child result does not match its admitted task");
  }
  if (
    result.parentLeaseGeneration !== task.parentLeaseGeneration
    || input.parent.leaseGeneration !== task.parentLeaseGeneration
  ) {
    throw new ChildResultError("STALE_PARENT_LEASE", "child result targets a stale parent lease");
  }
  if (
    Date.parse(result.completedAt) < Date.parse(task.admittedAt)
    || Date.parse(result.completedAt) > Date.parse(task.expiresAt)
  ) {
    throw new ChildResultError("RESULT_EXPIRED", "child completed outside its admitted lifetime");
  }
  const encodedBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (encodedBytes > task.outputByteBudget) {
    throw new ChildResultError("RESULT_TOO_LARGE", "child result exceeds its output budget");
  }
  const references = result.claims.flatMap(
    ({ evidenceRefs, calculatedResultRefs }) => [...evidenceRefs, ...calculatedResultRefs],
  );
  if (references.some((reference) => !input.allowedEvidenceRefs.has(referenceKey(reference)))) {
    throw new ChildResultError(
      "EVIDENCE_OUT_OF_SCOPE",
      "child result cites evidence outside its validated scope and cutoff",
    );
  }
  return { task, result, encodedBytes };
}

export interface MergedClaim extends ChildClaim {
  childTaskId: string;
  role: ChildRole;
}

export interface ClaimConflict {
  claimKey: string;
  values: string[];
  childTaskIds: string[];
}

export interface MergedChildResults {
  completion: "completed" | "partial" | "failed";
  claims: MergedClaim[];
  conflicts: ClaimConflict[];
  missingContext: string[];
  coverage: { inspectedRecords: number; truncated: boolean };
  receivedChildTaskIds: string[];
  missingChildTaskIds: string[];
}

export function mergeChildResults(
  expectedTasksInput: readonly ChildTask[],
  validated: readonly ValidatedChildResult[],
): MergedChildResults {
  const expectedTasks = expectedTasksInput.map((task) => ChildTaskSchema.parse(task));
  const firstTask = expectedTasks[0];
  if (firstTask !== undefined && expectedTasks.some((task) =>
    task.organizationId !== firstTask.organizationId
    || task.parentJobId !== firstTask.parentJobId
    || task.parentLeaseGeneration !== firstTask.parentLeaseGeneration
  )) {
    throw new ChildResultError("TASK_MISMATCH", "expected child tasks do not share one parent lease");
  }
  const expectedIds = new Set(expectedTasks.map(({ childTaskId }) => childTaskId));
  const expectedById = new Map(expectedTasks.map((task) => [task.childTaskId, task]));
  const seen = new Set<string>();
  for (const item of validated) {
    if (!expectedIds.has(item.task.childTaskId)) {
      throw new ChildResultError("TASK_MISMATCH", "result belongs to an unexpected child task");
    }
    if (JSON.stringify(ChildTaskSchema.parse(item.task)) !== JSON.stringify(expectedById.get(item.task.childTaskId))) {
      throw new ChildResultError("TASK_MISMATCH", "validated result substituted a different child task");
    }
    if (seen.has(item.task.childTaskId)) {
      throw new ChildResultError("DUPLICATE_CHILD_RESULT", "child result was supplied more than once");
    }
    seen.add(item.task.childTaskId);
  }

  const ordered = [...validated].sort((a, b) => a.task.childTaskId.localeCompare(b.task.childTaskId));
  const claims: MergedClaim[] = ordered.flatMap(({ task, result }) =>
    result.claims.map((claim) => ({ ...claim, childTaskId: task.childTaskId, role: task.role })),
  ).sort((a, b) => a.claimKey.localeCompare(b.claimKey) || a.childTaskId.localeCompare(b.childTaskId));

  const grouped = new Map<string, MergedClaim[]>();
  for (const claim of claims) grouped.set(claim.claimKey, [...(grouped.get(claim.claimKey) ?? []), claim]);
  const conflicts = [...grouped.entries()].flatMap(([claimKey, group]) => {
    const values = [...new Set(group.map(({ value }) => value))].sort();
    return values.length < 2 ? [] : [{
      claimKey,
      values,
      childTaskIds: [...new Set(group.map(({ childTaskId }) => childTaskId))].sort(),
    }];
  }).sort((a, b) => a.claimKey.localeCompare(b.claimKey));

  const receivedChildTaskIds = [...seen].sort();
  const missingChildTaskIds = [...expectedIds].filter((id) => !seen.has(id)).sort();
  const allCompleted =
    missingChildTaskIds.length === 0
    && ordered.every(({ result }) => result.completion === "completed");
  const allFailed =
    missingChildTaskIds.length === 0
    && ordered.length > 0
    && ordered.every(({ result }) => result.completion === "failed" || result.completion === "canceled");
  return {
    completion: allCompleted ? "completed" : allFailed ? "failed" : "partial",
    claims,
    conflicts,
    missingContext: [...new Set(ordered.flatMap(({ result }) => result.missingContext))].sort(),
    coverage: {
      inspectedRecords: ordered.reduce((sum, { result }) => sum + result.coverage.inspectedRecords, 0),
      truncated: missingChildTaskIds.length > 0 || ordered.some(({ result }) => result.coverage.truncated),
    },
    receivedChildTaskIds,
    missingChildTaskIds,
  };
}
