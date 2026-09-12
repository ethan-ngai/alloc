import { describe, expect, it } from "vitest";
import type { DurableJobMessage } from "@alloc/contracts";
import {
  InMemorySchedulerRepository,
  SchedulerInvariantError,
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

describe("InMemorySchedulerRepository", () => {
  it("admits each job at most once under concurrent claim calls", async () => {
    const repository = new InMemorySchedulerRepository();
    await repository.enqueue(job({ jobId: "job_a", deduplicationKey: "key-a" }));
    await repository.enqueue(job({ jobId: "job_b", deduplicationKey: "key-b" }));
    await repository.enqueue(job({ jobId: "job_c", deduplicationKey: "key-c" }));

    const claims = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      repository.claimNext({
        workerId: `worker_${index}`,
        now: NOW,
        leaseDurationMs: 30_000,
        policy: {
          maxConsecutiveP0: 8,
          maxConsecutiveNonP2: 20,
          maxRunningPerPrincipal: 20,
          p2AgingMs: 60_000,
          essentialP1Types: ["source_ingestion", "reconciliation"],
        },
      }),
    ));
    const claimedIds = claims.flatMap(({ job: claimed }) => claimed === null ? [] : [claimed.jobId]);
    expect(claimedIds).toHaveLength(3);
    expect(new Set(claimedIds)).toEqual(new Set(["job_a", "job_b", "job_c"]));
  });

  it("preserves one final follow-up generation while the first job runs", async () => {
    const repository = new InMemorySchedulerRepository();
    await repository.enqueue(job({ jobId: "job_running" }));
    await repository.claimNext({ workerId: "worker_primary", now: NOW, leaseDurationMs: 30_000 });

    const first = await repository.enqueue(job({
      jobId: "job_follow_up_a",
      revision: 2,
      inputVersions: [{ type: "source", id: "source_ledger", revision: 2 }],
    }));
    expect(first.action).toBe("follow_up");
    const second = await repository.enqueue(job({
      jobId: "job_follow_up_b",
      revision: 3,
      priority: "P1",
      inputVersions: [{ type: "source", id: "source_ledger", revision: 3 }],
    }));
    expect(second.action).toBe("coalesced");

    const records = await repository.list();
    expect(records).toHaveLength(2);
    expect(records.find(({ jobId }) => jobId === "job_follow_up_a")).toMatchObject({
      revision: 3,
      priority: "P1",
      inputVersions: [{ type: "source", id: "source_ledger", revision: 3 }],
    });
  });

  it("rejects changed payload reuse for a job ID", async () => {
    const repository = new InMemorySchedulerRepository();
    const original = job();
    await repository.enqueue(original);
    await expect(repository.enqueue({ ...original, priority: "P0" })).rejects.toEqual(
      expect.objectContaining({ code: "COALESCING_CONFLICT" }),
    );
    expect(await repository.enqueue(original)).toMatchObject({ action: "deduplicated" });
  });

  it("recovers an expired lease with a monotonic generation and fences the old worker", async () => {
    const repository = new InMemorySchedulerRepository();
    await repository.enqueue(job());
    const first = await repository.claimNext({
      workerId: "worker_first",
      now: NOW,
      leaseDurationMs: 1_000,
    });
    expect(first.job?.lease?.generation).toBe(1);

    const recovered = await repository.claimNext({
      workerId: "worker_recovery",
      now: new Date("2026-09-12T16:00:01.000Z"),
      leaseDurationMs: 1_000,
    });
    expect(recovered.job?.lease).toMatchObject({ ownerId: "worker_recovery", generation: 2 });
    await expect(repository.release(
      "job_default",
      { ownerId: "worker_first", generation: 1 },
      new Date("2026-09-12T16:00:01.100Z"),
      { state: "completed", currentStep: "done", checkpointRefs: [] },
    )).rejects.toBeInstanceOf(SchedulerInvariantError);
  });

  it("cancels at an expected revision and fences the previously leased worker", async () => {
    const repository = new InMemorySchedulerRepository();
    await repository.enqueue(job());
    const claimed = await repository.claimNext({
      workerId: "worker_primary",
      now: NOW,
      leaseDurationMs: 30_000,
    });
    const canceled = await repository.cancel("job_default", claimed.job!.revision, "operator_canceled");
    expect(canceled).toMatchObject({
      state: "canceled",
      currentStep: "operator_canceled",
      lease: null,
    });
    await expect(repository.release(
      "job_default",
      { ownerId: "worker_primary", generation: 1 },
      new Date("2026-09-12T16:00:01.000Z"),
      { state: "completed", currentStep: "stale", checkpointRefs: [] },
    )).rejects.toEqual(expect.objectContaining({ code: "LEASE_INACTIVE" }));
    await expect(repository.cancel("job_default", claimed.job!.revision, "again")).rejects.toEqual(
      expect.objectContaining({ code: "REVISION_MISMATCH" }),
    );
  });

  it("expires pending and running jobs and clears active leases", async () => {
    const repository = new InMemorySchedulerRepository();
    await repository.enqueue(job({
      jobId: "job_pending_deadline",
      deduplicationKey: "deadline-pending",
      deadlineAt: "2026-09-12T16:00:00.000Z",
    }));
    await repository.enqueue(job({
      jobId: "job_running_deadline",
      deduplicationKey: "deadline-running",
      deadlineAt: "2026-09-12T16:00:01.000Z",
    }));
    await repository.claimNext({
      workerId: "worker_primary",
      now: new Date("2026-09-12T15:59:59.000Z"),
      leaseDurationMs: 30_000,
    });
    const expired = await repository.expireDeadlines(
      new Date("2026-09-12T16:00:01.000Z"),
    );
    expect(expired.map(({ jobId }) => jobId)).toEqual([
      "job_pending_deadline",
      "job_running_deadline",
    ]);
    expect(expired.every(({ state, lease }) => state === "failed" && lease === null)).toBe(true);
  });
});
