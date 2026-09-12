import {
  ContractErrorSchema,
  DurableJobMessageSchema,
  IdSchema,
  type ContractError,
  type DurableJobMessage,
} from "@alloc/contracts";

export type Priority = DurableJobMessage["priority"];
export type JobState = DurableJobMessage["state"];
export type JobType = DurableJobMessage["jobType"];

export interface AdmissionPolicy {
  maxConsecutiveP0: number;
  maxConsecutiveNonP2: number;
  maxRunningPerPrincipal: number;
  p2AgingMs: number;
  essentialP1Types: readonly JobType[];
}

export interface FairnessState {
  consecutiveP0: number;
  consecutiveNonP2: number;
}

export interface AdmissionResult {
  selected: DurableJobMessage | null;
  expiredJobIds: string[];
  principalLimitedJobIds: string[];
  fairness: FairnessState;
}

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = Object.freeze({
  maxConsecutiveP0: 8,
  maxConsecutiveNonP2: 20,
  maxRunningPerPrincipal: 2,
  p2AgingMs: 60_000,
  essentialP1Types: ["source_ingestion", "reconciliation"] as const,
});

export const INITIAL_FAIRNESS_STATE: FairnessState = Object.freeze({
  consecutiveP0: 0,
  consecutiveNonP2: 0,
});

export class SchedulerInvariantError extends Error {
  constructor(
    readonly code:
      | "INVALID_TRANSITION"
      | "LEASE_INACTIVE"
      | "LEASE_MISSING"
      | "LEASE_OWNER_MISMATCH"
      | "LEASE_GENERATION_MISMATCH"
      | "LEASE_EXPIRED"
      | "JOB_NOT_CLAIMABLE"
      | "JOB_DEADLINE_EXPIRED"
      | "COALESCING_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "SchedulerInvariantError";
  }
}

function milliseconds(timestamp: string): number {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) {
    throw new TypeError(`invalid timestamp: ${timestamp}`);
  }
  return value;
}

function compareJobs(left: DurableJobMessage, right: DurableJobMessage): number {
  const leftDeadline = left.deadlineAt === null ? Number.POSITIVE_INFINITY : milliseconds(left.deadlineAt);
  const rightDeadline = right.deadlineAt === null ? Number.POSITIVE_INFINITY : milliseconds(right.deadlineAt);
  return (
    leftDeadline - rightDeadline
    || milliseconds(left.eligibleAt) - milliseconds(right.eligibleAt)
    || left.jobId.localeCompare(right.jobId)
  );
}

function nextFairness(priority: Priority, previous: FairnessState): FairnessState {
  if (priority === "P0") {
    return {
      consecutiveP0: previous.consecutiveP0 + 1,
      consecutiveNonP2: previous.consecutiveNonP2 + 1,
    };
  }
  if (priority === "P1") {
    return {
      consecutiveP0: 0,
      consecutiveNonP2: previous.consecutiveNonP2 + 1,
    };
  }
  return { consecutiveP0: 0, consecutiveNonP2: 0 };
}

function validatePolicy(policy: AdmissionPolicy): void {
  for (const [name, value] of Object.entries({
    maxConsecutiveP0: policy.maxConsecutiveP0,
    maxConsecutiveNonP2: policy.maxConsecutiveNonP2,
    maxRunningPerPrincipal: policy.maxRunningPerPrincipal,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (!Number.isSafeInteger(policy.p2AgingMs) || policy.p2AgingMs < 0) {
    throw new RangeError("p2AgingMs must be a non-negative safe integer");
  }
}

export function parseDurableJob(input: unknown): DurableJobMessage {
  return DurableJobMessageSchema.parse(input);
}

export function selectNextJob(
  jobs: readonly DurableJobMessage[],
  now: Date,
  fairness: FairnessState = INITIAL_FAIRNESS_STATE,
  policy: AdmissionPolicy = DEFAULT_ADMISSION_POLICY,
): AdmissionResult {
  validatePolicy(policy);
  if (
    !Number.isSafeInteger(fairness.consecutiveP0)
    || fairness.consecutiveP0 < 0
    || !Number.isSafeInteger(fairness.consecutiveNonP2)
    || fairness.consecutiveNonP2 < 0
  ) {
    throw new RangeError("fairness counters must be non-negative safe integers");
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid date");

  const runningByPrincipal = new Map<string, number>();
  for (const job of jobs) {
    if (
      job.state === "running"
      && job.lease !== null
      && milliseconds(job.lease.expiresAt) > nowMs
    ) {
      runningByPrincipal.set(
        job.originPrincipalId,
        (runningByPrincipal.get(job.originPrincipalId) ?? 0) + 1,
      );
    }
  }

  const expiredJobIds: string[] = [];
  const principalLimitedJobIds: string[] = [];
  const candidates: DurableJobMessage[] = [];
  for (const job of jobs) {
    const expiredRunning =
      job.state === "running"
      && job.lease !== null
      && milliseconds(job.lease.expiresAt) <= nowMs;
    if (job.state !== "pending" && job.state !== "waiting_for_retry" && !expiredRunning) continue;
    if (milliseconds(job.eligibleAt) > nowMs) continue;
    if (job.deadlineAt !== null && milliseconds(job.deadlineAt) <= nowMs) {
      expiredJobIds.push(job.jobId);
      continue;
    }
    if ((runningByPrincipal.get(job.originPrincipalId) ?? 0) >= policy.maxRunningPerPrincipal) {
      principalLimitedJobIds.push(job.jobId);
      continue;
    }
    candidates.push(job);
  }

  const p0 = candidates.filter((job) => job.priority === "P0").sort(compareJobs);
  const p1 = candidates.filter((job) => job.priority === "P1").sort(compareJobs);
  const p2 = candidates.filter((job) => job.priority === "P2").sort(compareJobs);
  const essentialTypes = new Set(policy.essentialP1Types);
  const essentialP1 = p1.filter((job) => essentialTypes.has(job.jobType));

  let selected: DurableJobMessage | undefined;
  if (p0.length > 0) {
    selected =
      fairness.consecutiveP0 >= policy.maxConsecutiveP0 && essentialP1.length > 0
        ? essentialP1[0]
        : p0[0];
  } else {
    const agedP2 = p2.filter((job) => nowMs - milliseconds(job.eligibleAt) >= policy.p2AgingMs);
    selected =
      fairness.consecutiveNonP2 >= policy.maxConsecutiveNonP2 && agedP2.length > 0
        ? agedP2[0]
        : p1[0] ?? p2[0];
  }

  return {
    selected: selected ?? null,
    expiredJobIds: expiredJobIds.sort(),
    principalLimitedJobIds: principalLimitedJobIds.sort(),
    fairness: selected === undefined ? fairness : nextFairness(selected.priority, fairness),
  };
}

const ALLOWED_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = Object.freeze({
  pending: ["running", "failed", "canceled"],
  running: ["completed", "waiting_for_approval", "waiting_for_retry", "failed", "canceled"],
  waiting_for_approval: ["pending", "failed", "canceled"],
  waiting_for_retry: ["running", "failed", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
});

export function assertTransition(from: JobState, to: JobState): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new SchedulerInvariantError("INVALID_TRANSITION", `cannot transition job from ${from} to ${to}`);
  }
}

export interface LeaseToken {
  ownerId: string;
  generation: number;
}

export function assertActiveLease(job: DurableJobMessage, token: LeaseToken, now: Date): void {
  if (job.state !== "running") {
    throw new SchedulerInvariantError("LEASE_INACTIVE", "only a running job can use a lease");
  }
  if (job.lease === null) {
    throw new SchedulerInvariantError("LEASE_MISSING", "job has no active lease");
  }
  if (job.lease.ownerId !== token.ownerId) {
    throw new SchedulerInvariantError("LEASE_OWNER_MISMATCH", "worker does not own this lease");
  }
  if (job.lease.generation !== token.generation) {
    throw new SchedulerInvariantError("LEASE_GENERATION_MISMATCH", "lease generation is stale");
  }
  if (milliseconds(job.lease.expiresAt) <= now.getTime()) {
    throw new SchedulerInvariantError("LEASE_EXPIRED", "lease has expired");
  }
}

function positiveDuration(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
    throw new RangeError("lease duration must be a positive safe integer");
  }
}

export function claimJob(
  jobInput: DurableJobMessage,
  workerIdInput: string,
  lastLeaseGeneration: number,
  now: Date,
  leaseDurationMs: number,
): DurableJobMessage {
  const job = parseDurableJob(jobInput);
  const workerId = IdSchema.parse(workerIdInput);
  positiveDuration(leaseDurationMs);
  if (!Number.isSafeInteger(lastLeaseGeneration) || lastLeaseGeneration < 0) {
    throw new RangeError("lastLeaseGeneration must be a non-negative safe integer");
  }
  if (job.deadlineAt !== null && milliseconds(job.deadlineAt) <= now.getTime()) {
    throw new SchedulerInvariantError("JOB_DEADLINE_EXPIRED", "job deadline has expired");
  }

  const reclaiming = job.state === "running";
  if (reclaiming) {
    if (job.lease === null || milliseconds(job.lease.expiresAt) > now.getTime()) {
      throw new SchedulerInvariantError("JOB_NOT_CLAIMABLE", "running job still has an active lease");
    }
    if (job.lease.generation !== lastLeaseGeneration) {
      throw new SchedulerInvariantError(
        "LEASE_GENERATION_MISMATCH",
        "stored lease generation does not match the expired lease",
      );
    }
  } else if (
    (job.state !== "pending" && job.state !== "waiting_for_retry")
    || job.lease !== null
    || milliseconds(job.eligibleAt) > now.getTime()
  ) {
    throw new SchedulerInvariantError("JOB_NOT_CLAIMABLE", "job is not currently claimable");
  }

  return parseDurableJob({
    ...job,
    revision: job.revision + 1,
    state: "running",
    attempts: job.attempts + 1,
    lease: {
      ownerId: workerId,
      generation: lastLeaseGeneration + 1,
      expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
    },
  });
}

export function renewLease(
  jobInput: DurableJobMessage,
  token: LeaseToken,
  now: Date,
  leaseDurationMs: number,
): DurableJobMessage {
  const job = parseDurableJob(jobInput);
  positiveDuration(leaseDurationMs);
  assertActiveLease(job, token, now);
  return parseDurableJob({
    ...job,
    revision: job.revision + 1,
    lease: {
      ...job.lease,
      expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
    },
  });
}

export interface StepRelease {
  state: Exclude<JobState, "pending" | "running">;
  currentStep: string;
  checkpointRefs: DurableJobMessage["checkpointRefs"];
  eligibleAt?: string;
}

export function releaseStep(
  jobInput: DurableJobMessage,
  token: LeaseToken,
  now: Date,
  release: StepRelease,
): DurableJobMessage {
  const job = parseDurableJob(jobInput);
  assertActiveLease(job, token, now);
  assertTransition(job.state, release.state);
  if (release.state === "waiting_for_retry" && release.eligibleAt === undefined) {
    throw new SchedulerInvariantError(
      "JOB_NOT_CLAIMABLE",
      "waiting_for_retry requires a new eligibility timestamp",
    );
  }
  const eligibleAt = release.eligibleAt ?? job.eligibleAt;
  if (release.state === "waiting_for_retry" && milliseconds(eligibleAt) <= now.getTime()) {
    throw new SchedulerInvariantError(
      "JOB_NOT_CLAIMABLE",
      "retry eligibility must be in the future",
    );
  }
  return parseDurableJob({
    ...job,
    revision: job.revision + 1,
    state: release.state,
    currentStep: release.currentStep,
    checkpointRefs: release.checkpointRefs,
    eligibleAt,
    lease: null,
  });
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableCodes: readonly ContractError["code"][];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  retryableCodes: ["DEPENDENCY_UNAVAILABLE", "INTERNAL_ERROR"] as const,
});

export type RetryDecision =
  | { action: "retry"; delayMs: number; eligibleAt: string }
  | { action: "fail"; reason: "terminal_error" | "attempts_exhausted" };

export function decideRetry(
  errorInput: ContractError,
  attempts: number,
  now: Date,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): RetryDecision {
  const error = ContractErrorSchema.parse(errorInput);
  for (const [name, value] of Object.entries({
    maxAttempts: policy.maxAttempts,
    baseDelayMs: policy.baseDelayMs,
    maxDelayMs: policy.maxDelayMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (policy.baseDelayMs > policy.maxDelayMs) {
    throw new RangeError("baseDelayMs cannot exceed maxDelayMs");
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError("attempts must include the failed attempt and be a positive safe integer");
  }
  if (!error.retryable || !policy.retryableCodes.includes(error.code)) {
    return { action: "fail", reason: "terminal_error" };
  }
  if (attempts >= policy.maxAttempts) {
    return { action: "fail", reason: "attempts_exhausted" };
  }
  const delayMs = Math.min(policy.baseDelayMs * (2 ** (attempts - 1)), policy.maxDelayMs);
  return {
    action: "retry",
    delayMs,
    eligibleAt: new Date(now.getTime() + delayMs).toISOString(),
  };
}

type RecordRef = DurableJobMessage["inputVersions"][number];

function mergeInputVersions(left: readonly RecordRef[], right: readonly RecordRef[]): RecordRef[] {
  const merged = new Map<string, RecordRef>();
  for (const reference of [...left, ...right]) {
    const key = `${reference.type}\u0000${reference.id}`;
    const previous = merged.get(key);
    if (
      previous === undefined
      || (reference.revision ?? 0) > (previous.revision ?? 0)
    ) {
      merged.set(key, reference);
    }
  }
  return [...merged.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id),
  );
}

function higherPriority(left: Priority, right: Priority): Priority {
  const rank: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };
  return rank[left] <= rank[right] ? left : right;
}

function earlierDeadline(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return milliseconds(left) <= milliseconds(right) ? left : right;
}

export type CoalescingResult =
  | { action: "replace_pending"; job: DurableJobMessage }
  | { action: "schedule_follow_up"; job: DurableJobMessage }
  | { action: "create"; job: DurableJobMessage };

export function coalesceJobs(
  existingInput: DurableJobMessage | null,
  incomingInput: DurableJobMessage,
): CoalescingResult {
  const incoming = parseDurableJob(incomingInput);
  if (incoming.state !== "pending" || incoming.lease !== null || incoming.attempts !== 0) {
    throw new SchedulerInvariantError(
      "COALESCING_CONFLICT",
      "incoming coalescing candidates must be new pending jobs without a lease or attempts",
    );
  }
  if (existingInput === null) return { action: "create", job: incoming };
  const existing = parseDurableJob(existingInput);
  if (
    existing.organizationId !== incoming.organizationId
    || existing.deduplicationKey !== incoming.deduplicationKey
    || existing.jobType !== incoming.jobType
    || existing.scope.type !== incoming.scope.type
    || existing.scope.id !== incoming.scope.id
  ) {
    throw new SchedulerInvariantError(
      "COALESCING_CONFLICT",
      "jobs must share organization, type, and deduplication key",
    );
  }

  if (existing.state === "pending" || existing.state === "waiting_for_retry") {
    return {
      action: "replace_pending",
      job: parseDurableJob({
        ...existing,
        revision: existing.revision + 1,
        priority: higherPriority(existing.priority, incoming.priority),
        inputVersions: mergeInputVersions(existing.inputVersions, incoming.inputVersions),
        eligibleAt:
          milliseconds(existing.eligibleAt) <= milliseconds(incoming.eligibleAt)
            ? existing.eligibleAt
            : incoming.eligibleAt,
        deadlineAt: earlierDeadline(existing.deadlineAt, incoming.deadlineAt),
      }),
    };
  }

  if (existing.state === "running") {
    return { action: "schedule_follow_up", job: incoming };
  }
  return { action: "create", job: incoming };
}
