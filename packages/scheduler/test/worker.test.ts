import { describe, expect, it } from "vitest";
import type { ContractError, DurableJobMessage } from "@alloc/contracts";
import {
  InMemorySchedulerRepository,
  JobExecutionError,
  SchedulerWorker,
} from "../src/index.js";

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

function executionError(overrides: Partial<ContractError> = {}): JobExecutionError {
  return new JobExecutionError({
    schemaVersion: "1.0.0",
    code: "DEPENDENCY_UNAVAILABLE",
    message: "temporary dependency outage",
    retryable: true,
    correlationId: "correlation_worker",
    ...overrides,
  });
}

describe("SchedulerWorker", () => {
  it("runs the admitted handler and persists its completed state", async () => {
    const repository = new InMemorySchedulerRepository();
    await repository.enqueue(job());
    const worker = new SchedulerWorker(repository, {
      summary_rebuild: async () => ({
        state: "completed",
        currentStep: "done",
        checkpointRefs: [{ type: "job_artifact", id: "artifact_summary", revision: 1 }],
      }),
    }, { workerId: "worker_primary", leaseDurationMs: 30_000, clock: () => NOW });

    const result = await worker.runOnce();
    expect(result).toMatchObject({
      status: "released",
      job: {
        state: "completed",
        currentStep: "done",
        attempts: 1,
        lease: null,
      },
    });
  });

  it("retries transient handler failures and terminates policy failures", async () => {
    const transientRepository = new InMemorySchedulerRepository();
    await transientRepository.enqueue(job());
    const transientWorker = new SchedulerWorker(transientRepository, {
      summary_rebuild: async () => { throw executionError(); },
    }, { workerId: "worker_primary", leaseDurationMs: 30_000, clock: () => NOW });
    expect(await transientWorker.runOnce()).toMatchObject({
      status: "released",
      job: {
        state: "waiting_for_retry",
        eligibleAt: "2026-09-12T16:00:01.000Z",
      },
    });

    const terminalRepository = new InMemorySchedulerRepository();
    await terminalRepository.enqueue(job());
    const terminalWorker = new SchedulerWorker(terminalRepository, {
      summary_rebuild: async () => {
        throw executionError({ code: "POLICY_DENIED", retryable: true });
      },
    }, { workerId: "worker_primary", leaseDurationMs: 30_000, clock: () => NOW });
    expect(await terminalWorker.runOnce()).toMatchObject({
      status: "released",
      job: { state: "failed" },
    });
  });

  it("renews a lease during a bounded handler step", async () => {
    const repository = new InMemorySchedulerRepository();
    await repository.enqueue(job());
    const times = [
      new Date("2026-09-12T16:00:00.000Z"),
      new Date("2026-09-12T16:00:05.000Z"),
      new Date("2026-09-12T16:00:06.000Z"),
    ];
    const worker = new SchedulerWorker(repository, {
      summary_rebuild: async (_job, context) => {
        const renewed = await context.renew(30_000);
        expect(renewed.lease?.expiresAt).toBe("2026-09-12T16:00:35.000Z");
        return { state: "completed", currentStep: "done", checkpointRefs: [] };
      },
    }, {
      workerId: "worker_primary",
      leaseDurationMs: 10_000,
      clock: () => times.shift() ?? new Date("2026-09-12T16:00:06.000Z"),
    });
    expect(await worker.runOnce()).toMatchObject({ status: "released", job: { state: "completed" } });
  });

  it("cannot overwrite recovery performed after its lease expires", async () => {
    const repository = new InMemorySchedulerRepository();
    await repository.enqueue(job());
    const times = [
      new Date("2026-09-12T16:00:00.000Z"),
      new Date("2026-09-12T16:00:02.000Z"),
    ];
    const staleWorker = new SchedulerWorker(repository, {
      summary_rebuild: async () => {
        const recovered = await repository.claimNext({
          workerId: "worker_recovery",
          now: new Date("2026-09-12T16:00:02.000Z"),
          leaseDurationMs: 30_000,
        });
        expect(recovered.job?.lease?.generation).toBe(2);
        return { state: "completed", currentStep: "stale-result", checkpointRefs: [] };
      },
    }, {
      workerId: "worker_stale",
      leaseDurationMs: 1_000,
      clock: () => times.shift() ?? new Date("2026-09-12T16:00:02.000Z"),
    });
    expect(await staleWorker.runOnce()).toEqual({
      status: "fenced",
      jobId: "job_default",
      reason: "LEASE_OWNER_MISMATCH",
    });
    expect(await repository.get("job_default")).toMatchObject({
      state: "running",
      currentStep: "queued",
      lease: { ownerId: "worker_recovery", generation: 2 },
    });
  });

  it("moves a missing synthetic handler into bounded retry", async () => {
    const repository = new InMemorySchedulerRepository();
    await repository.enqueue(job());
    const worker = new SchedulerWorker(
      repository,
      {},
      { workerId: "worker_primary", leaseDurationMs: 30_000, clock: () => NOW },
    );
    expect(await worker.runOnce()).toMatchObject({
      status: "released",
      job: { state: "waiting_for_retry" },
    });
  });

  it("sweeps deadline-expired work before claiming another step", async () => {
    const repository = new InMemorySchedulerRepository();
    await repository.enqueue(job({ deadlineAt: NOW.toISOString() }));
    const worker = new SchedulerWorker(
      repository,
      {},
      { workerId: "worker_primary", leaseDurationMs: 30_000, clock: () => NOW },
    );
    expect(await worker.runOnce()).toEqual({
      status: "idle",
      expiredJobIds: ["job_default"],
      principalLimitedJobIds: [],
    });
    expect(await repository.get("job_default")).toMatchObject({
      state: "failed",
      currentStep: "deadline_expired",
      lease: null,
    });
  });
});
