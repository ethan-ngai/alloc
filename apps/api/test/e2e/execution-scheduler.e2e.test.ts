import { usd } from "@alloc/financial-rules";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopProcess, waitForSuccess } from "../support/process.js";
import {
  auditTypes, createApprovedRequest, employeeToken, intentState, pendingIntent, providerOperations, readRequest,
  receiptsFor, schedulerJobs, startExecutionHarness, startWorker, stopExecutionHarness, type ExecutionHarness,
} from "../support/execution-e2e.js";

let harness: ExecutionHarness;

beforeAll(async () => {
  harness = await startExecutionHarness("execution-scheduler-e2e");
}, 240_000);

afterAll(async () => {
  await stopExecutionHarness(harness, stopProcess);
});

describe("action delivery through the durable scheduler", () => {
  it("hands one intent to exactly one of two concurrent workers", async () => {
    const token = await employeeToken();
    const requestId = await createApprovedRequest(harness, "command_e2e_sched_fence", 18_000, token);
    const intent = await pendingIntent(harness, requestId);

    const first = startWorker(harness);
    const second = startWorker(harness);
    await waitForSuccess(
      async () => (await intentState(harness, requestId)) === "succeeded",
      30_000,
      "the intent to settle under racing workers",
      first,
    );
    await stopProcess(first);
    await stopProcess(second);

    // Lease fencing plus provider idempotency: one operation, one receipt, and a
    // job that was claimed once and never retried.
    expect(await providerOperations(harness, intent.idempotencyKey)).toBe(1);
    const receipts = await receiptsFor(harness, requestId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: "succeeded", amount: usd(18_000) });
    expect(await auditTypes(harness, intent.actionIntentId)).toEqual(["action.settled"]);
    const jobs = (await schedulerJobs(harness).list())
      .filter((job) => job.deduplicationKey === `action_dispatch:${intent.actionIntentId}`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: "completed", attempts: 1, currentStep: "action_delivery_settled" });
    expect((await readRequest(harness, requestId, token)).commitment)
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(18_000) });
  }, 120_000);

  it("retries an unresolved delivery with backoff and completes once the provider recovers", async () => {
    const token = await employeeToken();
    const requestId = await createApprovedRequest(harness, "command_e2e_sched_recover", 12_000, token);
    const intent = await pendingIntent(harness, requestId);
    const jobs = schedulerJobs(harness);

    const offline = startWorker(harness, { SIMULATED_PROVIDER_FAILURE_MODE: "unavailable_before_send" });
    await waitForSuccess(
      async () => (await jobs.list()).some((job) => job.currentStep === "action_delivery_unresolved"),
      30_000,
      "the job to park for retry",
      offline,
    );
    await stopProcess(offline);

    const open = (await jobs.list()).filter((job) => job.inputVersions.some((ref) => ref.id === intent.actionIntentId));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ state: "waiting_for_retry", attempts: 1, lease: null, currentStep: "action_delivery_unresolved" });
    expect(await providerOperations(harness, intent.idempotencyKey)).toBe(0);
    expect(await receiptsFor(harness, requestId)).toHaveLength(0);
    // The reservation is retained while the outcome is unresolved.
    expect((await readRequest(harness, requestId, token)).commitment)
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(12_000) });

    const online = startWorker(harness);
    await waitForSuccess(async () => (await intentState(harness, requestId)) === "succeeded", 30_000, "the recovered delivery to settle", online);
    await stopProcess(online);

    expect(await providerOperations(harness, intent.idempotencyKey)).toBe(1);
    expect(await receiptsFor(harness, requestId)).toHaveLength(1);
    const settled = (await jobs.list()).filter((job) => job.inputVersions.some((ref) => ref.id === intent.actionIntentId));
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ state: "completed", currentStep: "action_delivery_settled" });
    expect(settled[0]!.attempts).toBeGreaterThanOrEqual(2);
    expect((await readRequest(harness, requestId, token)).commitment)
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(12_000) });
  }, 120_000);
});
