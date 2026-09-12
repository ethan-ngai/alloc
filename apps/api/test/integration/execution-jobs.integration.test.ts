import { ActionIntentSchema, DurableJobMessageSchema, type DurableJobMessage } from "@alloc/contracts";
import { usd } from "@alloc/financial-rules";
import { MongoSchedulerRepository, SchedulerWorker, type RetryPolicy } from "@alloc/scheduler";
import { startMongoReplicaSet, type MongoTestCluster } from "@alloc/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { ACTION_RECEIPTS_COLLECTION, PROVIDER_OPERATIONS_COLLECTION } from "../../src/execution/collections.js";
import { MongoActionExecutor } from "../../src/execution/executor.js";
import {
  ACTION_JOB_DEADLINE_MS, ACTION_JOB_DEDUPLICATION_PREFIX, enqueueActionableIntents, createActionJobHandler,
} from "../../src/execution/job-handler.js";
import { SimulatedSpendProvider, type SpendProvider } from "../../src/execution/provider.js";
import { ACTION_INTENTS_COLLECTION } from "../../src/finance/collections.js";
import type { FinancialContext } from "../../src/finance/internal.js";
import type { FinancialRepository } from "../../src/finance/repository.js";
import { connectMongoRuntime, type MongoRuntime } from "../../src/mongo/runtime.js";
import { northstarSeed } from "../support/finance.js";

const ORGANIZATION_ID = "org_northstar";
const EMPLOYEE = "employee_maya_chen";
const VENDOR = "vendor_buffalo_hotel";
const PURPOSE = "Buffalo Beacon pilot trip";
const WORKER_ID = "worker_integration";
const LEASE_MS = 30_000;

interface Harness {
  readonly cluster: MongoTestCluster;
  readonly runtime: MongoRuntime;
  readonly finance: FinancialRepository;
  readonly jobs: MongoSchedulerRepository;
  readonly provider: SimulatedSpendProvider;
  readonly executor: MongoActionExecutor;
  /** Test-controlled clock shared by the worker and the assertions. */
  now(): Date;
  advance(ms: number): void;
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.runtime.close().catch(() => undefined);
  await harness?.cluster.stop();
  harness = undefined;
});

async function open(): Promise<Harness> {
  const cluster = await startMongoReplicaSet({ label: "execution-jobs" });
  const runtime = await connectMongoRuntime({ uri: cluster.uri, database: cluster.database });
  await runtime.finance.seed(ORGANIZATION_ID, northstarSeed(ORGANIZATION_ID));
  const provider = new SimulatedSpendProvider(runtime.db);
  let clockMs = Date.parse("2026-09-12T14:00:00.000Z");
  harness = {
    cluster,
    runtime,
    finance: runtime.finance,
    jobs: new MongoSchedulerRepository(runtime.db),
    provider,
    executor: new MongoActionExecutor(runtime.db, runtime.withTransaction, provider),
    now: () => new Date(clockMs),
    advance: (ms: number) => {
      clockMs += ms;
    },
  };
  return harness;
}

function workerOver(overrides: { provider?: SpendProvider; retryPolicy?: RetryPolicy } = {}): SchedulerWorker {
  const current = harness!;
  const executor = overrides.provider === undefined
    ? current.executor
    : new MongoActionExecutor(current.runtime.db, current.runtime.withTransaction, overrides.provider);
  return new SchedulerWorker(
    current.jobs,
    { reconciliation: createActionJobHandler(executor, { now: current.now }) },
    {
      workerId: WORKER_ID,
      leaseDurationMs: LEASE_MS,
      clock: current.now,
      ...(overrides.retryPolicy === undefined ? {} : { retryPolicy: overrides.retryPolicy }),
    },
  );
}

async function approvedIntent(finance: FinancialRepository, commandId: string, amountMinor = 18_000) {
  const revision = await finance.createRequest(
    { principalId: EMPLOYEE, organizationId: ORGANIZATION_ID, roles: ["employee"] } satisfies FinancialContext,
    {
      meta: { schemaVersion: "1.0.0", organizationId: ORGANIZATION_ID, commandId, correlationId: `correlation_${commandId}`, expectedVersions: [] },
      payload: {
        requesterId: EMPLOYEE,
        purpose: PURPOSE,
        fullAmount: usd(amountMinor),
        categoryId: "category_travel",
        vendorId: VENDOR,
        projectId: "project_beacon",
        scopes: [
          { type: "organization", id: ORGANIZATION_ID },
          { type: "department", id: "department_field_engineering" },
        ],
      },
    },
  );
  expect(revision.evaluationState).toBe("approved");
  const intent = await finance.currentActionIntent(ORGANIZATION_ID, revision.requestId);
  if (intent === null) {
    throw new Error(`approved request ${revision.requestId} has no action intent`);
  }
  return { revision, intent };
}

function receiptCount(): Promise<number> {
  return harness!.runtime.db.collection(ACTION_RECEIPTS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID });
}

function providerOperationCount(): Promise<number> {
  return harness!.runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID });
}

async function storedIntent(actionIntentId: string) {
  const document = await harness!.runtime.db.collection(ACTION_INTENTS_COLLECTION)
    .findOne({ organizationId: ORGANIZATION_ID, actionIntentId }, { projection: { _id: 0 } });
  return ActionIntentSchema.parse(document);
}

describe("action jobs against a real replica set", () => {
  it("produces one job per actionable intent and skips work a live job already covers", async () => {
    const current = await open();
    const { intent } = await approvedIntent(current.finance, "command_jobs_enqueue");

    const first = await enqueueActionableIntents(current.runtime.db, current.jobs, { limit: 5, now: current.now() });
    expect(first.skipped).toEqual([]);
    expect(first.enqueued).toHaveLength(1);

    const jobs = await current.jobs.list();
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job).toMatchObject({
      jobType: "reconciliation",
      priority: "P1",
      state: "pending",
      attempts: 0,
      lease: null,
      organizationId: ORGANIZATION_ID,
      originPrincipalId: EMPLOYEE,
      serviceIdentityId: "service_action_executor",
      scope: { type: "organization", id: ORGANIZATION_ID },
      deduplicationKey: `${ACTION_JOB_DEDUPLICATION_PREFIX}:${intent.actionIntentId}`,
      inputVersions: [{ type: "action_intent", id: intent.actionIntentId, revision: 1 }],
      checkpointRefs: [],
    });
    expect(job.jobId).toBe(first.enqueued[0]);
    expect(Date.parse(job.deadlineAt!)).toBe(current.now().getTime() + ACTION_JOB_DEADLINE_MS);
    expect(job.eligibleAt).toBe(current.now().toISOString());

    const second = await enqueueActionableIntents(current.runtime.db, current.jobs, { limit: 5, now: current.now() });
    expect(second.enqueued).toEqual([]);
    expect(second.skipped).toEqual([intent.actionIntentId]);
    expect(await current.jobs.list()).toHaveLength(1);
  }, 120_000);

  it("runs a produced job through one leased step and completes it once the intent settles", async () => {
    const current = await open();
    const { revision, intent } = await approvedIntent(current.finance, "command_jobs_run");
    await enqueueActionableIntents(current.runtime.db, current.jobs, { limit: 5, now: current.now() });

    const result = await workerOver().runOnce();
    expect(result.status).toBe("released");
    if (result.status !== "released") throw new Error("unreachable");
    expect(result.job).toMatchObject({
      jobId: (await current.jobs.list())[0]!.jobId,
      state: "completed",
      currentStep: "action_delivery_settled",
      attempts: 1,
      lease: null,
    });
    expect(result.job.checkpointRefs).toEqual([
      { type: "action_intent", id: intent.actionIntentId, revision: 3 },
    ]);

    expect((await storedIntent(intent.actionIntentId)).state).toBe("succeeded");
    expect(await receiptCount()).toBe(1);
    expect(await providerOperationCount()).toBe(1);
    expect(await current.finance.getCommitment(ORGANIZATION_ID, revision.requestId))
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(18_000) });

    // Nothing is actionable and the settled revision is covered: the pass is idle.
    const idle = await workerOver().runOnce();
    expect(idle.status).toBe("idle");
    expect(await current.jobs.list()).toHaveLength(1);
  }, 120_000);

  it("keeps the job waiting with backoff while the provider is unreachable, then settles it", async () => {
    const current = await open();
    const { revision, intent } = await approvedIntent(current.finance, "command_jobs_backoff");
    current.provider.failureMode = "unavailable_before_send";
    await enqueueActionableIntents(current.runtime.db, current.jobs, { limit: 5, now: current.now() });

    const waiting = await workerOver().runOnce();
    expect(waiting.status).toBe("released");
    if (waiting.status !== "released") throw new Error("unreachable");
    expect(waiting.job).toMatchObject({
      state: "waiting_for_retry",
      currentStep: "action_delivery_unresolved",
      attempts: 1,
    });
    expect(Date.parse(waiting.job.eligibleAt)).toBeGreaterThan(current.now().getTime());
    expect(await receiptCount()).toBe(0);
    expect(await providerOperationCount()).toBe(0);
    expect(await current.finance.getCommitment(ORGANIZATION_ID, revision.requestId))
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(18_000) });

    // Backoff holds the job until it is eligible again.
    expect((await workerOver().runOnce()).status).toBe("idle");

    current.advance(60_000);
    current.provider.failureMode = "none";
    const settled = await workerOver().runOnce();
    expect(settled.status).toBe("released");
    if (settled.status !== "released") throw new Error("unreachable");
    expect(settled.job).toMatchObject({ state: "completed", attempts: 2 });
    expect((await storedIntent(intent.actionIntentId)).state).toBe("succeeded");
    expect(await receiptCount()).toBe(1);
    expect(await providerOperationCount()).toBe(1);
  }, 120_000);

  it("maps a failing delivery onto capped retry and then failure", async () => {
    const current = await open();
    const { intent } = await approvedIntent(current.finance, "command_jobs_retry");
    await enqueueActionableIntents(current.runtime.db, current.jobs, { limit: 5, now: current.now() });

    const exploding: SpendProvider = {
      deliver: async () => {
        throw new Error("simulated provider fault");
      },
      lookup: async () => ({ kind: "absent" }),
    };
    const retried = await workerOver({ provider: exploding }).runOnce();
    expect(retried.status).toBe("released");
    if (retried.status !== "released") throw new Error("unreachable");
    expect(retried.job).toMatchObject({ state: "waiting_for_retry", attempts: 1 });

    // With the retry budget spent the same failure becomes terminal.
    current.advance(5_000);
    const exhausting = await workerOver({
      provider: exploding,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 1_000, retryableCodes: ["DEPENDENCY_UNAVAILABLE"] },
    }).runOnce();
    expect(exhausting.status).toBe("released");
    if (exhausting.status !== "released") throw new Error("unreachable");
    expect(exhausting.job).toMatchObject({ state: "failed", attempts: 2 });
    expect((await storedIntent(intent.actionIntentId)).state).toBe("dispatching");
    expect(await receiptCount()).toBe(0);
  }, 120_000);

  it("re-enqueues a terminal failure for an intent that is still actionable", async () => {
    const current = await open();
    const { intent } = await approvedIntent(current.finance, "command_jobs_requeue");
    const first = await enqueueActionableIntents(current.runtime.db, current.jobs, { limit: 5, now: current.now() });

    const job = (await current.jobs.list())[0]!;
    const claimed = await current.jobs.claimNext({ workerId: WORKER_ID, now: current.now(), leaseDurationMs: LEASE_MS });
    expect(claimed.job?.lease?.generation).toBe(1);
    await current.jobs.release(
      job.jobId,
      { ownerId: WORKER_ID, generation: 1 },
      current.now(),
      { state: "failed", currentStep: "provider_unavailable", checkpointRefs: [] },
    );
    expect((await storedIntent(intent.actionIntentId)).state).toBe("pending");

    const second = await enqueueActionableIntents(current.runtime.db, current.jobs, { limit: 5, now: current.now() });
    expect(second.enqueued).toHaveLength(1);
    expect(second.enqueued[0]).not.toBe(first.enqueued[0]);
    expect(await current.jobs.list()).toHaveLength(2);

    // The replacement job settles the intent that the failed attempt left behind.
    expect((await workerOver().runOnce()).status).toBe("released");
    expect((await storedIntent(intent.actionIntentId)).state).toBe("succeeded");
    expect(await receiptCount()).toBe(1);
  }, 120_000);

  it("settles every intent a job names and renews the lease across the step", async () => {
    const current = await open();
    const first = await approvedIntent(current.finance, "command_jobs_multi_a");
    const second = await approvedIntent(current.finance, "command_jobs_multi_b", 12_000);
    const job: DurableJobMessage = DurableJobMessageSchema.parse({
      schemaVersion: "1.0.0",
      organizationId: ORGANIZATION_ID,
      jobId: "job_multi_step",
      revision: 1,
      jobType: "reconciliation",
      originPrincipalId: EMPLOYEE,
      serviceIdentityId: "service_action_executor",
      scope: { type: "organization", id: ORGANIZATION_ID },
      priority: "P1",
      state: "pending",
      inputVersions: [
        { type: "action_intent", id: first.intent.actionIntentId, revision: 1 },
        { type: "action_intent", id: second.intent.actionIntentId, revision: 1 },
      ],
      deduplicationKey: `${ACTION_JOB_DEDUPLICATION_PREFIX}:multi`,
      currentStep: "action_delivery_queued",
      checkpointRefs: [],
      attempts: 0,
      eligibleAt: current.now().toISOString(),
      deadlineAt: null,
      lease: null,
    });
    await current.jobs.enqueue(job);

    const result = await workerOver().runOnce();
    expect(result.status).toBe("released");
    if (result.status !== "released") throw new Error("unreachable");
    expect(result.job).toMatchObject({ state: "completed", attempts: 1, currentStep: "action_delivery_settled" });
    expect(result.job.checkpointRefs.map(({ id }) => id).sort()).toEqual(
      [first.intent.actionIntentId, second.intent.actionIntentId].sort(),
    );
    expect(await receiptCount()).toBe(2);
    expect(await providerOperationCount()).toBe(2);
  }, 120_000);
});
