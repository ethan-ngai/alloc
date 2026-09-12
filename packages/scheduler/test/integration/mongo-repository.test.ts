import type { DurableJobMessage } from "@alloc/contracts";
import { startMongoReplicaSet, type MongoTestCluster } from "@alloc/test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MongoSchedulerRepository,
  SchedulerInvariantError,
  ensureSchedulerCollection,
} from "../../src/index.js";

const NOW = new Date("2026-09-12T16:00:00.000Z");
const LEASE_MS = 30_000;

const ADMISSION_POLICY = {
  maxConsecutiveP0: 8,
  maxConsecutiveNonP2: 20,
  maxRunningPerPrincipal: 50,
  p2AgingMs: 60_000,
  essentialP1Types: ["source_ingestion", "reconciliation"],
} as const;

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

let cluster: MongoTestCluster;
let repository: MongoSchedulerRepository;

beforeAll(async () => {
  cluster = await startMongoReplicaSet({ label: "scheduler" });
  await ensureSchedulerCollection(cluster.client.db(cluster.database));
}, 120_000);

afterAll(async () => {
  await cluster?.stop();
});

beforeEach(async () => {
  const db = cluster.client.db(cluster.database);
  await db.collection("scheduler_jobs").deleteMany({});
  repository = new MongoSchedulerRepository(db);
});

describe("MongoSchedulerRepository against a real replica set", () => {
  it("admits each job exactly once when many workers claim concurrently", async () => {
    const ids = ["job_a", "job_b", "job_c", "job_d"];
    for (const jobId of ids) {
      await repository.enqueue(job({ jobId, deduplicationKey: jobId }));
    }

    // Every worker races the same four documents; CAS fencing must not hand the
    // same job to two owners.
    const claims = await Promise.all(Array.from({ length: 16 }, (_, index) =>
      repository.claimNext({
        workerId: `worker_${index}`,
        now: NOW,
        leaseDurationMs: LEASE_MS,
        policy: ADMISSION_POLICY,
      })));

    const claimed = claims.flatMap(({ job: result }) => result === null ? [] : [result]);
    expect(claimed.map(({ jobId }) => jobId).sort()).toEqual(ids);
    expect(new Set(claimed.map(({ lease }) => lease?.ownerId)).size).toBe(ids.length);

    const stored = await repository.list();
    expect(stored.every(({ state }) => state === "running")).toBe(true);
  });

  it("recovers an expired lease and fences the displaced worker's write", async () => {
    await repository.enqueue(job({ jobId: "job_lease" }));
    const first = await repository.claimNext({
      workerId: "worker_first",
      now: NOW,
      leaseDurationMs: 1_000,
      policy: ADMISSION_POLICY,
    });
    expect(first.job?.lease).toMatchObject({ ownerId: "worker_first", generation: 1 });

    const recovered = await repository.claimNext({
      workerId: "worker_recovery",
      now: new Date(NOW.getTime() + 5_000),
      leaseDurationMs: LEASE_MS,
      policy: ADMISSION_POLICY,
    });
    expect(recovered.job?.lease).toMatchObject({ ownerId: "worker_recovery", generation: 2 });

    await expect(repository.release(
      "job_lease",
      { ownerId: "worker_first", generation: 1 },
      new Date(NOW.getTime() + 5_100),
      { state: "completed", currentStep: "done", checkpointRefs: [] },
    )).rejects.toBeInstanceOf(SchedulerInvariantError);

    // The fenced write must not have advanced the job.
    expect(await repository.get("job_lease")).toMatchObject({
      state: "running",
      lease: { ownerId: "worker_recovery" },
    });
  });

  it("interrupts a background job and resumes it from its checkpoint after urgent work", async () => {
    await repository.enqueue(job({ jobId: "job_background", deduplicationKey: "background" }));
    const background = await repository.claimNext({
      workerId: "worker_background",
      now: NOW,
      leaseDurationMs: LEASE_MS,
      policy: ADMISSION_POLICY,
    });
    expect(background.job?.jobId).toBe("job_background");

    // Bounded step: the worker yields at a checkpoint instead of running to completion.
    const parked = await repository.release(
      "job_background",
      { ownerId: "worker_background", generation: background.job!.lease!.generation },
      new Date(NOW.getTime() + 1_000),
      {
        state: "waiting_for_retry",
        currentStep: "scenario_step_2",
        checkpointRefs: [{ type: "checkpoint", id: "ckpt_scenario_2" }],
        eligibleAt: new Date(NOW.getTime() + 10_000).toISOString(),
      },
    );
    expect(parked).toMatchObject({ state: "waiting_for_retry", currentStep: "scenario_step_2" });

    // An urgent request arrives while the background job is parked.
    await repository.enqueue(job({
      jobId: "job_urgent",
      jobType: "request_investigation",
      priority: "P0",
      deduplicationKey: "urgent",
      scope: { type: "department", id: "dept_field_ops" },
    }));
    const urgent = await repository.claimNext({
      workerId: "worker_urgent",
      now: new Date(NOW.getTime() + 2_000),
      leaseDurationMs: LEASE_MS,
      policy: ADMISSION_POLICY,
    });
    expect(urgent.job?.jobId).toBe("job_urgent");

    await repository.release(
      "job_urgent",
      { ownerId: "worker_urgent", generation: urgent.job!.lease!.generation },
      new Date(NOW.getTime() + 3_000),
      { state: "completed", currentStep: "answered", checkpointRefs: [] },
    );

    // Once the background job is eligible again it resumes at its checkpoint.
    const resumed = await repository.claimNext({
      workerId: "worker_background_2",
      now: new Date(NOW.getTime() + 11_000),
      leaseDurationMs: LEASE_MS,
      policy: ADMISSION_POLICY,
    });
    expect(resumed.job).toMatchObject({
      jobId: "job_background",
      state: "running",
      currentStep: "scenario_step_2",
      checkpointRefs: [{ type: "checkpoint", id: "ckpt_scenario_2" }],
    });
    expect(resumed.job!.lease!.generation).toBeGreaterThan(background.job!.lease!.generation);
  });

  it("survives a process restart by reloading durable state from MongoDB", async () => {
    await repository.enqueue(job({ jobId: "job_durable", deduplicationKey: "durable" }));
    const claimed = await repository.claimNext({
      workerId: "worker_before_restart",
      now: NOW,
      leaseDurationMs: LEASE_MS,
      policy: ADMISSION_POLICY,
    });
    await repository.release(
      "job_durable",
      { ownerId: "worker_before_restart", generation: claimed.job!.lease!.generation },
      new Date(NOW.getTime() + 1_000),
      {
        state: "waiting_for_retry",
        currentStep: "step_after_restart",
        checkpointRefs: [{ type: "checkpoint", id: "ckpt_durable" }],
        eligibleAt: new Date(NOW.getTime() + 5_000).toISOString(),
      },
    );

    // A fresh repository stands in for a restarted worker process.
    const restarted = new MongoSchedulerRepository(cluster.client.db(cluster.database));
    expect(await restarted.get("job_durable")).toMatchObject({
      state: "waiting_for_retry",
      currentStep: "step_after_restart",
      checkpointRefs: [{ type: "checkpoint", id: "ckpt_durable" }],
      lease: null,
    });
  });

  it("rejects a reused job ID whose payload changed and deduplicates an identical retry", async () => {
    const original = job({ jobId: "job_dedupe", deduplicationKey: "dedupe" });
    await repository.enqueue(original);
    await expect(repository.enqueue({ ...original, priority: "P0" })).rejects.toEqual(
      expect.objectContaining({ code: "COALESCING_CONFLICT" }),
    );
    expect(await repository.enqueue(original)).toMatchObject({ action: "deduplicated" });
    expect(await repository.list()).toHaveLength(1);
  });

  it("expires overdue jobs and clears their leases", async () => {
    await repository.enqueue(job({
      jobId: "job_deadline",
      deduplicationKey: "deadline",
      deadlineAt: new Date(NOW.getTime() + 2_000).toISOString(),
    }));
    await repository.claimNext({
      workerId: "worker_deadline",
      now: NOW,
      leaseDurationMs: LEASE_MS,
      policy: ADMISSION_POLICY,
    });

    const expired = await repository.expireDeadlines(new Date(NOW.getTime() + 3_000));
    expect(expired.map(({ jobId }) => jobId)).toEqual(["job_deadline"]);
    expect(await repository.get("job_deadline")).toMatchObject({
      state: "failed",
      currentStep: "deadline_expired",
      lease: null,
    });
  });
});
