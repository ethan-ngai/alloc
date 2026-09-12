import { usd } from "@alloc/financial-rules";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_OPERATIONS_COLLECTION } from "../../src/execution/collections.js";
import { stopProcess, waitForExit, waitForSuccess } from "../support/process.js";
import {
  ORGANIZATION_ID, auditTypes, createApprovedRequest, employeeToken, intentFor, intentState, pendingIntent,
  providerOperations, readRequest, receiptsFor, schedulerJobs, startExecutionHarness, startWorker,
  stopExecutionHarness, type ExecutionHarness,
} from "../support/execution-e2e.js";

let harness: ExecutionHarness;

beforeAll(async () => {
  harness = await startExecutionHarness("execution-e2e");
}, 240_000);

afterAll(async () => {
  await stopExecutionHarness(harness, stopProcess);
});

describe("simulated action delivery end to end", () => {
  it("approves, dispatches, crashes after the provider side effect, restarts, and reconciles one action", async () => {
    const token = await employeeToken();
    const requestId = await createApprovedRequest(harness, "command_e2e_exec_crash", 18_000, token);
    const intent = await pendingIntent(harness, requestId);
    const jobs = schedulerJobs(harness);

    // The worker applies the provider operation and is killed before it can
    // persist a receipt, which is the crash-after-side-effect window.
    const crashing = startWorker(harness, {
      EXECUTOR_FAULT: "crash_after_provider_apply",
      EXECUTOR_FAULT_TARGET: intent.actionIntentId,
    });
    await waitForExit(crashing.child, 30_000);
    expect(await providerOperations(harness, intent.idempotencyKey)).toBe(1);
    expect(await receiptsFor(harness, requestId)).toHaveLength(0);
    expect((await intentFor(harness, requestId)).state).toBe("dispatching");

    // The job is still leased by the dead worker; recovery has to expire it.
    const stranded = (await jobs.list())[0]!;
    expect(stranded).toMatchObject({ state: "running", attempts: 1, currentStep: "action_delivery_queued" });
    expect(stranded.lease?.ownerId).toBeTypeOf("string");

    // No receipt may mean no release: the commitment is still outstanding.
    expect((await readRequest(harness, requestId, token)).commitment)
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(18_000) });

    // The restarted worker recovers the expired lease, re-delivers the same key,
    // and settles the intent against the single operation the provider recorded.
    const restarted = startWorker(harness);
    await waitForSuccess(async () => (await intentState(harness, requestId)) === "succeeded", 30_000, "the recovered intent to succeed", restarted);
    await stopProcess(restarted);

    const receipts = await receiptsFor(harness, requestId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      outcome: "succeeded",
      amount: usd(18_000),
      providerInstanceId: "provider_simulated_spend",
      actionIntentRef: { type: "action_intent", id: intent.actionIntentId },
    });
    const operations = await harness.inspector.db.collection(PROVIDER_OPERATIONS_COLLECTION)
      .find({ organizationId: ORGANIZATION_ID }).toArray();
    expect(operations).toHaveLength(1);
    expect(receipts[0]?.providerOperationId).toBe(operations[0]?.providerOperationId);
    expect((await readRequest(harness, requestId, token)).commitment)
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(18_000) });
    expect(await auditTypes(harness, intent.actionIntentId)).toEqual(["action.settled"]);

    // One job owned this intent throughout: the recovery was a second attempt of
    // the same lease, not a second job.
    const forIntent = (await jobs.list()).filter((job) => job.inputVersions.some((ref) => ref.id === intent.actionIntentId));
    expect(forIntent).toHaveLength(1);
    expect(forIntent[0]).toMatchObject({ state: "completed", attempts: 2, currentStep: "action_delivery_settled" });
    expect(forIntent[0]!.checkpointRefs).toEqual([
      { type: "action_intent", id: intent.actionIntentId, revision: 3 },
    ]);
  }, 120_000);

  it("resolves an ambiguous provider timeout by reconciliation instead of a second delivery", async () => {
    const token = await employeeToken();
    const requestId = await createApprovedRequest(harness, "command_e2e_exec_timeout", 12_000, token);
    const intent = await pendingIntent(harness, requestId);

    const worker = startWorker(harness, {
      SIMULATED_PROVIDER_FAILURE_MODE: "timeout_after_apply",
      // Armed but aimed at another intent: the fault must not fire here.
      EXECUTOR_FAULT: "crash_after_provider_apply",
      EXECUTOR_FAULT_TARGET: "action_0123456789abcdef01234567",
    });
    await waitForSuccess(async () => (await intentState(harness, requestId)) === "succeeded", 30_000, "the reconciled intent to succeed", worker);
    expect(worker.child.exitCode).toBeNull();
    await stopProcess(worker);

    expect(await providerOperations(harness, intent.idempotencyKey)).toBe(1);
    const receipts = await receiptsFor(harness, requestId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: "succeeded", amount: usd(12_000) });
    expect(await auditTypes(harness, intent.actionIntentId)).toEqual(["action.outcome_unknown", "action.reconciled"]);
  }, 120_000);

  it("keeps an undelivered intent pending until the provider accepts it", async () => {
    const token = await employeeToken();
    const requestId = await createApprovedRequest(harness, "command_e2e_exec_offline", 9_000, token);
    const intent = await pendingIntent(harness, requestId);

    const offline = startWorker(harness, { SIMULATED_PROVIDER_FAILURE_MODE: "unavailable_before_send" });
    await waitForSuccess(
      async () => (await auditTypes(harness, intent.actionIntentId)).includes("action.delivery_failed"),
      30_000,
      "a failed delivery attempt",
      offline,
    );
    await stopProcess(offline);

    expect(await providerOperations(harness, intent.idempotencyKey)).toBe(0);
    expect(await receiptsFor(harness, requestId)).toHaveLength(0);
    expect((await readRequest(harness, requestId, token)).commitment)
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(9_000) });

    const online = startWorker(harness);
    await waitForSuccess(async () => (await intentState(harness, requestId)) === "succeeded", 30_000, "the retried intent to succeed", online);
    await stopProcess(online);

    expect(await providerOperations(harness, intent.idempotencyKey)).toBe(1);
    expect(await receiptsFor(harness, requestId)).toHaveLength(1);
    expect((await readRequest(harness, requestId, token)).commitment)
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(9_000) });
  }, 120_000);
});
