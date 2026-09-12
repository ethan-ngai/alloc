import type { DurableJobMessage } from "@alloc/contracts";
import {
  type AdmissionPolicy,
  type FairnessState,
  type LeaseToken,
  type StepRelease,
  DEFAULT_ADMISSION_POLICY,
  INITIAL_FAIRNESS_STATE,
  SchedulerInvariantError,
  claimJob,
  coalesceJobs,
  parseDurableJob,
  releaseStep,
  renewLease,
  selectNextJob,
} from "./scheduler.js";

export interface EnqueueResult {
  action: "created" | "coalesced" | "follow_up" | "deduplicated";
  job: DurableJobMessage;
}

export interface ClaimOptions {
  workerId: string;
  now: Date;
  leaseDurationMs: number;
  fairness?: FairnessState;
  policy?: AdmissionPolicy;
}

export interface ClaimResult {
  job: DurableJobMessage | null;
  fairness: FairnessState;
  expiredJobIds: string[];
  principalLimitedJobIds: string[];
}

export interface SchedulerRepository {
  enqueue(job: DurableJobMessage): Promise<EnqueueResult>;
  claimNext(options: ClaimOptions): Promise<ClaimResult>;
  renew(jobId: string, token: LeaseToken, now: Date, leaseDurationMs: number): Promise<DurableJobMessage>;
  release(jobId: string, token: LeaseToken, now: Date, release: StepRelease): Promise<DurableJobMessage>;
  cancel(jobId: string, expectedRevision: number, currentStep: string): Promise<DurableJobMessage>;
  expireDeadlines(now: Date): Promise<DurableJobMessage[]>;
  get(jobId: string): Promise<DurableJobMessage | null>;
  list(): Promise<DurableJobMessage[]>;
}

interface StoredJob {
  job: DurableJobMessage;
  lastLeaseGeneration: number;
}

function sameJob(left: DurableJobMessage, right: DurableJobMessage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function activeForCoalescing(job: DurableJobMessage): boolean {
  return job.state === "pending" || job.state === "waiting_for_retry" || job.state === "running";
}

function sameCoalescingPartition(left: DurableJobMessage, right: DurableJobMessage): boolean {
  return (
    left.organizationId === right.organizationId
    && left.deduplicationKey === right.deduplicationKey
    && left.jobType === right.jobType
    && left.scope.type === right.scope.type
    && left.scope.id === right.scope.id
  );
}

/**
 * Deterministic reference store for contract tests and synthetic handlers.
 *
 * Each method performs all reads and writes before its Promise resolves, which
 * makes a method atomic within one JavaScript process. It is deliberately not a
 * durable or multi-process substitute for the MongoDB implementation.
 */
export class InMemorySchedulerRepository implements SchedulerRepository {
  readonly #records = new Map<string, StoredJob>();

  async enqueue(jobInput: DurableJobMessage): Promise<EnqueueResult> {
    const incoming = parseDurableJob(jobInput);
    const sameId = this.#records.get(incoming.jobId);
    if (sameId !== undefined) {
      if (sameJob(sameId.job, incoming)) {
        return { action: "deduplicated", job: parseDurableJob(sameId.job) };
      }
      throw new SchedulerInvariantError(
        "COALESCING_CONFLICT",
        `job ID ${incoming.jobId} was reused with a different payload`,
      );
    }

    const matching = [...this.#records.values()]
      .filter(({ job }) => activeForCoalescing(job) && sameCoalescingPartition(job, incoming))
      .sort(({ job: left }, { job: right }) => {
        const leftPending = left.state === "pending" || left.state === "waiting_for_retry";
        const rightPending = right.state === "pending" || right.state === "waiting_for_retry";
        return Number(rightPending) - Number(leftPending) || left.jobId.localeCompare(right.jobId);
      });
    const existing = matching[0];
    const result = coalesceJobs(existing?.job ?? null, incoming);
    if (result.action === "replace_pending" && existing !== undefined) {
      existing.job = result.job;
      return { action: "coalesced", job: parseDurableJob(result.job) };
    }
    this.#records.set(result.job.jobId, { job: result.job, lastLeaseGeneration: 0 });
    return {
      action: result.action === "schedule_follow_up" ? "follow_up" : "created",
      job: parseDurableJob(result.job),
    };
  }

  async claimNext(options: ClaimOptions): Promise<ClaimResult> {
    const admission = selectNextJob(
      [...this.#records.values()].map(({ job }) => job),
      options.now,
      options.fairness ?? INITIAL_FAIRNESS_STATE,
      options.policy ?? DEFAULT_ADMISSION_POLICY,
    );
    if (admission.selected === null) {
      return {
        job: null,
        fairness: admission.fairness,
        expiredJobIds: admission.expiredJobIds,
        principalLimitedJobIds: admission.principalLimitedJobIds,
      };
    }
    const stored = this.#records.get(admission.selected.jobId);
    if (stored === undefined) {
      throw new Error("selected job disappeared from the in-memory repository");
    }
    const claimed = claimJob(
      stored.job,
      options.workerId,
      stored.lastLeaseGeneration,
      options.now,
      options.leaseDurationMs,
    );
    stored.job = claimed;
    stored.lastLeaseGeneration = claimed.lease?.generation ?? stored.lastLeaseGeneration;
    return {
      job: parseDurableJob(claimed),
      fairness: admission.fairness,
      expiredJobIds: admission.expiredJobIds,
      principalLimitedJobIds: admission.principalLimitedJobIds,
    };
  }

  async renew(
    jobId: string,
    token: LeaseToken,
    now: Date,
    leaseDurationMs: number,
  ): Promise<DurableJobMessage> {
    const stored = this.#require(jobId);
    stored.job = renewLease(stored.job, token, now, leaseDurationMs);
    return parseDurableJob(stored.job);
  }

  async release(
    jobId: string,
    token: LeaseToken,
    now: Date,
    release: StepRelease,
  ): Promise<DurableJobMessage> {
    const stored = this.#require(jobId);
    stored.job = releaseStep(stored.job, token, now, release);
    return parseDurableJob(stored.job);
  }

  async cancel(
    jobId: string,
    expectedRevision: number,
    currentStep: string,
  ): Promise<DurableJobMessage> {
    const stored = this.#require(jobId);
    if (stored.job.revision !== expectedRevision) {
      throw new SchedulerInvariantError(
        "REVISION_MISMATCH",
        `expected job revision ${expectedRevision}, found ${stored.job.revision}`,
      );
    }
    if (stored.job.state === "canceled") return parseDurableJob(stored.job);
    if (stored.job.state === "completed" || stored.job.state === "failed") {
      throw new SchedulerInvariantError(
        "JOB_NOT_CLAIMABLE",
        `cannot cancel terminal ${stored.job.state} job`,
      );
    }
    stored.job = parseDurableJob({
      ...stored.job,
      revision: stored.job.revision + 1,
      state: "canceled",
      currentStep,
      lease: null,
    });
    return parseDurableJob(stored.job);
  }

  async expireDeadlines(now: Date): Promise<DurableJobMessage[]> {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid date");
    const expired: DurableJobMessage[] = [];
    for (const stored of this.#records.values()) {
      const deadlineMs = stored.job.deadlineAt === null
        ? Number.POSITIVE_INFINITY
        : Date.parse(stored.job.deadlineAt);
      if (
        deadlineMs > nowMs
        || stored.job.state === "completed"
        || stored.job.state === "failed"
        || stored.job.state === "canceled"
      ) {
        continue;
      }
      stored.job = parseDurableJob({
        ...stored.job,
        revision: stored.job.revision + 1,
        state: "failed",
        currentStep: "deadline_expired",
        lease: null,
      });
      expired.push(parseDurableJob(stored.job));
    }
    return expired.sort((left, right) => left.jobId.localeCompare(right.jobId));
  }

  async get(jobId: string): Promise<DurableJobMessage | null> {
    const stored = this.#records.get(jobId);
    return stored === undefined ? null : parseDurableJob(stored.job);
  }

  async list(): Promise<DurableJobMessage[]> {
    return [...this.#records.values()]
      .map(({ job }) => parseDurableJob(job))
      .sort((left, right) => left.jobId.localeCompare(right.jobId));
  }

  #require(jobId: string): StoredJob {
    const stored = this.#records.get(jobId);
    if (stored === undefined) throw new Error(`job not found: ${jobId}`);
    return stored;
  }
}
