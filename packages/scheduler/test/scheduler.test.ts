import { describe, expect, it } from "vitest";
import {
  INITIAL_FAIRNESS_STATE,
  SchedulerInvariantError,
  assertActiveLease,
  assertTransition,
  claimJob,
  coalesceJobs,
  decideRetry,
  releaseStep,
  renewLease,
  selectNextJob,
} from "../src/index.js";
import type { ContractError, DurableJobMessage } from "@alloc/contracts";

const NOW = new Date("2026-09-12T16:00:00.000Z");

function job(overrides: Partial<DurableJobMessage> = {}): DurableJobMessage {
  return {
    schemaVersion: "1.0.0",
    organizationId: "org_northstar",
    jobId: "job_default",
    revision: 1,
    jobType: "summary_rebuild",
    originPrincipalId: "principal_eric",
    serviceIdentityId: "service_scheduler",
    scope: { type: "organization", id: "org_northstar" },
    priority: "P2",
    state: "pending",
    inputVersions: [],
    deduplicationKey: "northstar-summary",
    currentStep: "queued",
    checkpointRefs: [],
    attempts: 0,
    eligibleAt: "2026-09-12T15:00:00.000Z",
    deadlineAt: null,
    lease: null,
    ...overrides,
  };
}

describe("admission", () => {
  it("admits P0 before lower priorities and uses deadline order within a class", () => {
    const result = selectNextJob([
      job({ jobId: "job_background" }),
      job({ jobId: "job_later", priority: "P0", deadlineAt: "2026-09-12T16:10:00.000Z" }),
      job({ jobId: "job_sooner", priority: "P0", deadlineAt: "2026-09-12T16:05:00.000Z" }),
    ], NOW);
    expect(result.selected?.jobId).toBe("job_sooner");
    expect(result.fairness.consecutiveP0).toBe(1);
  });

  it("reserves a bounded opportunity for essential P1 work during sustained P0 load", () => {
    const result = selectNextJob([
      job({ jobId: "job_interactive", priority: "P0" }),
      job({ jobId: "job_ingest", priority: "P1", jobType: "source_ingestion" }),
      job({ jobId: "job_nonessential", priority: "P1", jobType: "forecast_refresh" }),
    ], NOW, { consecutiveP0: 8, consecutiveNonP2: 8 });
    expect(result.selected?.jobId).toBe("job_ingest");
    expect(result.fairness.consecutiveP0).toBe(0);
  });

  it("ages P2 into service when no P0 is waiting", () => {
    const result = selectNextJob([
      job({ jobId: "job_operational", priority: "P1" }),
      job({ jobId: "job_aged", priority: "P2" }),
    ], NOW, { consecutiveP0: 0, consecutiveNonP2: 20 });
    expect(result.selected?.jobId).toBe("job_aged");
  });

  it("reports expired and per-principal-limited work without admitting it", () => {
    const result = selectNextJob([
      job({ jobId: "job_running_a", state: "running", priority: "P0" }),
      job({ jobId: "job_running_b", state: "running", priority: "P0" }),
      job({ jobId: "job_limited", priority: "P0" }),
      job({
        jobId: "job_expired",
        originPrincipalId: "principal_other",
        priority: "P0",
        deadlineAt: NOW.toISOString(),
      }),
    ], NOW);
    expect(result.selected).toBeNull();
    expect(result.expiredJobIds).toEqual(["job_expired"]);
    expect(result.principalLimitedJobIds).toEqual(["job_limited"]);
    expect(result.fairness).toEqual(INITIAL_FAIRNESS_STATE);
  });
});

describe("job lifecycle", () => {
  it("allows documented resumable transitions and rejects terminal resurrection", () => {
    expect(() => assertTransition("running", "waiting_for_retry")).not.toThrow();
    expect(() => assertTransition("waiting_for_retry", "running")).not.toThrow();
    expect(() => assertTransition("completed", "running")).toThrowError(
      expect.objectContaining({ code: "INVALID_TRANSITION" }),
    );
  });

  it("fences stale workers by owner, generation, and expiration", () => {
    const leased = job({
      state: "running",
      lease: {
        ownerId: "worker_primary",
        generation: 4,
        expiresAt: "2026-09-12T16:01:00.000Z",
      },
    });
    expect(() => assertActiveLease(leased, { ownerId: "worker_primary", generation: 4 }, NOW)).not.toThrow();
    expect(() => assertActiveLease(leased, { ownerId: "worker_primary", generation: 3 }, NOW)).toThrowError(
      expect.objectContaining({ code: "LEASE_GENERATION_MISMATCH" }),
    );
    expect(() => assertActiveLease(leased, { ownerId: "worker_stale", generation: 4 }, NOW)).toThrowError(
      expect.objectContaining({ code: "LEASE_OWNER_MISMATCH" }),
    );
    expect(() => assertActiveLease(leased, { ownerId: "worker_primary", generation: 4 }, new Date("2026-09-12T16:01:00.000Z"))).toThrowError(
      expect.objectContaining({ code: "LEASE_EXPIRED" }),
    );
    expect(() => assertActiveLease(
      { ...leased, state: "waiting_for_retry" },
      { ownerId: "worker_primary", generation: 4 },
      NOW,
    )).toThrowError(expect.objectContaining({ code: "LEASE_INACTIVE" }));
  });

  it("increments lease generations when reclaiming an expired worker", () => {
    const expired = job({
      state: "running",
      revision: 4,
      attempts: 1,
      lease: {
        ownerId: "worker_stale",
        generation: 2,
        expiresAt: "2026-09-12T15:59:00.000Z",
      },
    });
    const reclaimed = claimJob(expired, "worker_recovery", 2, NOW, 30_000);
    expect(reclaimed).toMatchObject({
      state: "running",
      revision: 5,
      attempts: 2,
      lease: {
        ownerId: "worker_recovery",
        generation: 3,
        expiresAt: "2026-09-12T16:00:30.000Z",
      },
    });
    expect(() => assertActiveLease(
      reclaimed,
      { ownerId: "worker_stale", generation: 2 },
      NOW,
    )).toThrowError(expect.objectContaining({ code: "LEASE_OWNER_MISMATCH" }));
  });

  it("renews only the current lease and releases a checkpoint atomically", () => {
    const claimed = claimJob(job(), "worker_primary", 0, NOW, 30_000);
    const renewed = renewLease(
      claimed,
      { ownerId: "worker_primary", generation: 1 },
      new Date("2026-09-12T16:00:10.000Z"),
      30_000,
    );
    expect(renewed.lease?.expiresAt).toBe("2026-09-12T16:00:40.000Z");
    const paused = releaseStep(
      renewed,
      { ownerId: "worker_primary", generation: 1 },
      new Date("2026-09-12T16:00:11.000Z"),
      {
        state: "waiting_for_retry",
        currentStep: "resume_analysis",
        checkpointRefs: [{ type: "job_artifact", id: "artifact_checkpoint", revision: 1 }],
        eligibleAt: "2026-09-12T16:00:20.000Z",
      },
    );
    expect(paused).toMatchObject({
      state: "waiting_for_retry",
      currentStep: "resume_analysis",
      lease: null,
      checkpointRefs: [{ type: "job_artifact", id: "artifact_checkpoint", revision: 1 }],
    });
  });

  it("checkpoints P2, admits newly arrived P0, then resumes from the checkpoint", () => {
    const background = job({ jobId: "job_background", priority: "P2" });
    const claimedBackground = claimJob(background, "worker_primary", 0, NOW, 10_000);
    const pausedBackground = releaseStep(
      claimedBackground,
      { ownerId: "worker_primary", generation: 1 },
      new Date("2026-09-12T16:00:01.000Z"),
      {
        state: "waiting_for_retry",
        currentStep: "read_remaining_evidence",
        checkpointRefs: [{ type: "job_artifact", id: "artifact_partial", revision: 1 }],
        eligibleAt: "2026-09-12T16:00:02.000Z",
      },
    );
    const interactive = job({
      jobId: "job_interactive",
      priority: "P0",
      jobType: "request_investigation",
      deduplicationKey: "request-urgent",
      originPrincipalId: "principal_other",
    });
    const admission = selectNextJob(
      [pausedBackground, interactive],
      new Date("2026-09-12T16:00:03.000Z"),
    );
    expect(admission.selected?.jobId).toBe("job_interactive");

    const claimedInteractive = claimJob(
      interactive,
      "worker_primary",
      0,
      new Date("2026-09-12T16:00:03.000Z"),
      10_000,
    );
    const completedInteractive = releaseStep(
      claimedInteractive,
      { ownerId: "worker_primary", generation: 1 },
      new Date("2026-09-12T16:00:04.000Z"),
      { state: "completed", currentStep: "done", checkpointRefs: [] },
    );
    expect(selectNextJob(
      [pausedBackground, completedInteractive],
      new Date("2026-09-12T16:00:05.000Z"),
    ).selected?.jobId).toBe("job_background");

    const resumed = claimJob(
      pausedBackground,
      "worker_primary",
      1,
      new Date("2026-09-12T16:00:05.000Z"),
      10_000,
    );
    expect(resumed).toMatchObject({
      state: "running",
      currentStep: "read_remaining_evidence",
      checkpointRefs: [{ id: "artifact_partial" }],
      lease: { generation: 2 },
    });
  });
});

describe("retry policy", () => {
  function error(overrides: Partial<ContractError> = {}): ContractError {
    return {
      schemaVersion: "1.0.0",
      code: "DEPENDENCY_UNAVAILABLE",
      message: "temporary outage",
      retryable: true,
      correlationId: "correlation_retry",
      ...overrides,
    };
  }

  it("uses capped exponential backoff for allowlisted transient failures", () => {
    expect(decideRetry(error(), 1, NOW)).toEqual({
      action: "retry",
      delayMs: 1_000,
      eligibleAt: "2026-09-12T16:00:01.000Z",
    });
    expect(decideRetry(error(), 4, NOW, {
      maxAttempts: 10,
      baseDelayMs: 1_000,
      maxDelayMs: 5_000,
      retryableCodes: ["DEPENDENCY_UNAVAILABLE"],
    })).toEqual({
      action: "retry",
      delayMs: 5_000,
      eligibleAt: "2026-09-12T16:00:05.000Z",
    });
  });

  it("never retries a policy denial even when a caller labels it retryable", () => {
    expect(decideRetry(error({ code: "POLICY_DENIED" }), 1, NOW)).toEqual({
      action: "fail",
      reason: "terminal_error",
    });
    expect(decideRetry(error(), 5, NOW)).toEqual({
      action: "fail",
      reason: "attempts_exhausted",
    });
  });
});

describe("coalescing", () => {
  it("merges pending inputs, raises urgency, and retains the earliest deadline", () => {
    const result = coalesceJobs(
      job({
        jobId: "job_existing",
        revision: 2,
        inputVersions: [{ type: "source", id: "source_ledger", revision: 2 }],
        deadlineAt: "2026-09-12T16:30:00.000Z",
      }),
      job({
        jobId: "job_incoming",
        priority: "P1",
        inputVersions: [
          { type: "source", id: "source_ledger", revision: 3 },
          { type: "policy", id: "policy_current", revision: 1 },
        ],
        deadlineAt: "2026-09-12T16:20:00.000Z",
      }),
    );
    expect(result.action).toBe("replace_pending");
    expect(result.job).toMatchObject({
      jobId: "job_existing",
      revision: 3,
      priority: "P1",
      deadlineAt: "2026-09-12T16:20:00.000Z",
      inputVersions: [
        { type: "policy", id: "policy_current", revision: 1 },
        { type: "source", id: "source_ledger", revision: 3 },
      ],
    });
  });

  it("preserves running inputs and schedules the final generation as follow-up", () => {
    const running = job({ jobId: "job_running", state: "running" });
    const incoming = job({ jobId: "job_follow_up", revision: 3 });
    const result = coalesceJobs(running, incoming);
    expect(result).toEqual({ action: "schedule_follow_up", job: incoming });
    expect(running.inputVersions).toEqual([]);
  });

  it("rejects cross-organization deduplication collisions", () => {
    expect(() => coalesceJobs(
      job(),
      job({ organizationId: "org_juniper", scope: { type: "organization", id: "org_juniper" } }),
    )).toThrowError(SchedulerInvariantError);
  });

  it("rejects cross-scope collisions and non-new incoming jobs", () => {
    expect(() => coalesceJobs(
      job(),
      job({ scope: { type: "department", id: "department_engineering" } }),
    )).toThrowError(expect.objectContaining({ code: "COALESCING_CONFLICT" }));
    expect(() => coalesceJobs(
      null,
      job({ state: "waiting_for_retry", attempts: 1 }),
    )).toThrowError(expect.objectContaining({ code: "COALESCING_CONFLICT" }));
  });
});
