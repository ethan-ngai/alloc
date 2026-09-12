import { ActionIntentSchema, ActionReceiptSchema, CommitmentSchema, type ActionIntent, type ActionReceipt } from "@alloc/contracts";
import { usd } from "@alloc/financial-rules";
import { startMongoReplicaSet, type MongoTestCluster } from "@alloc/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { ACTION_RECEIPTS_COLLECTION, PROVIDER_OPERATIONS_COLLECTION } from "../../src/execution/collections.js";
import { EXECUTOR_SERVICE_IDENTITY, MongoActionExecutor, type IntentOutcome } from "../../src/execution/executor.js";
import { SimulatedSpendProvider, type ProviderDeliveryResult, type SpendProvider } from "../../src/execution/provider.js";
import { ACTION_INTENTS_COLLECTION, AUDIT_EVENTS_COLLECTION } from "../../src/finance/collections.js";
import type { FinancialContext } from "../../src/finance/internal.js";
import type { FinancialRepository } from "../../src/finance/repository.js";
import { connectMongoRuntime, type MongoRuntime } from "../../src/mongo/runtime.js";
import { northstarSeed } from "../support/finance.js";

const ORGANIZATION_ID = "org_northstar";
const EMPLOYEE = "employee_maya_chen";
const VENDOR = "vendor_buffalo_hotel";
const PURPOSE = "Buffalo Beacon pilot trip";
const TRAVEL_CATEGORY = "category_travel";

/** Outcomes that describe an intent the executor actually looked at. */
type ExaminedOutcome = Extract<IntentOutcome, { intent: ActionIntent }>;
/** Outcomes whose provider result is already persisted as a receipt. */
type SettledOutcome = Extract<IntentOutcome, { receipt: ActionReceipt }>;

interface Harness {
  readonly cluster: MongoTestCluster;
  readonly runtime: MongoRuntime;
  readonly finance: FinancialRepository;
  readonly provider: SimulatedSpendProvider;
  readonly executor: MongoActionExecutor;
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.runtime.close().catch(() => undefined);
  await harness?.cluster.stop();
  harness = undefined;
});

async function open(): Promise<Harness> {
  const cluster = await startMongoReplicaSet({ label: "execution" });
  const runtime = await connectMongoRuntime({ uri: cluster.uri, database: cluster.database });
  await runtime.finance.seed(ORGANIZATION_ID, northstarSeed(ORGANIZATION_ID));
  const provider = new SimulatedSpendProvider(runtime.db);
  harness = {
    cluster,
    runtime,
    finance: runtime.finance,
    provider,
    executor: new MongoActionExecutor(runtime.db, runtime.withTransaction, provider),
  };
  return harness;
}

function employeeContext(): FinancialContext {
  return { principalId: EMPLOYEE, organizationId: ORGANIZATION_ID, roles: ["employee"] };
}

/** Creates a request that policy approves, which is what generates the action intent. */
async function approvedRequest(finance: FinancialRepository, commandId: string, amountMinor = 18_000) {
  const revision = await finance.createRequest(employeeContext(), {
    meta: { schemaVersion: "1.0.0", organizationId: ORGANIZATION_ID, commandId, correlationId: `correlation_${commandId}`, expectedVersions: [] },
    payload: {
      requesterId: EMPLOYEE,
      purpose: PURPOSE,
      fullAmount: usd(amountMinor),
      categoryId: TRAVEL_CATEGORY,
      vendorId: VENDOR,
      projectId: "project_beacon",
      scopes: [
        { type: "organization", id: ORGANIZATION_ID },
        { type: "department", id: "department_field_engineering" },
        { type: "project", id: "project_beacon" },
      ],
    },
  });
  expect(revision.evaluationState).toBe("approved");
  const intent = await finance.currentActionIntent(ORGANIZATION_ID, revision.requestId);
  if (intent === null) {
    throw new Error(`approved request ${revision.requestId} has no action intent`);
  }
  return { revision, intent };
}

function examined(result: IntentOutcome): ExaminedOutcome {
  if (!("intent" in result)) {
    throw new Error(`expected the executor to examine an intent, received ${JSON.stringify(result)}`);
  }
  return result;
}

function settled(result: IntentOutcome): SettledOutcome {
  if (!("receipt" in result)) {
    throw new Error(`expected a persisted provider outcome, received ${JSON.stringify(result)}`);
  }
  return result;
}

function receiptDocument(receiptId: string, providerOperationId: string) {
  return {
    schemaVersion: "1.0.0",
    organizationId: ORGANIZATION_ID,
    receiptId,
    actionIntentRef: { type: "action_intent", id: "action_validator_probe", revision: 1 },
    providerInstanceId: "provider_simulated_spend",
    providerOperationId,
    outcome: "succeeded",
    amount: usd(1_000),
    observedAt: "2026-09-12T14:00:00.000Z",
  };
}

function operationDocument(providerOperationId: string, idempotencyKey: string) {
  return {
    schemaVersion: "1.0.0",
    organizationId: ORGANIZATION_ID,
    providerInstanceId: "provider_simulated_spend",
    providerOperationId,
    idempotencyKey,
    amount: usd(1_000),
    vendorId: VENDOR,
    outcome: "applied",
    observedAt: "2026-09-12T14:00:00.000Z",
  };
}

/** The executor's own audit trail, ordered by the intent revision it records. */
async function auditTypes(db: MongoRuntime["db"], actionIntentId?: string): Promise<string[]> {
  const events = await db.collection(AUDIT_EVENTS_COLLECTION)
    .find({
      organizationId: ORGANIZATION_ID,
      actorId: EXECUTOR_SERVICE_IDENTITY,
      ...(actionIntentId === undefined ? {} : { "subjectRef.id": actionIntentId }),
    })
    .sort({ "subjectRef.revision": 1 }).toArray();
  return events.map((event) => String(event.type));
}

describe("action executor against a real replica set", () => {
  it("delivers a pending intent once and records one receipt for one provider operation", async () => {
    const { runtime, finance, executor } = await open();
    const { intent, revision } = await approvedRequest(finance, "command_execute_once");
    expect(intent).toMatchObject({ state: "pending", revision: 1, providerInstanceId: "provider_simulated_spend" });

    const dispatched = settled(await executor.dispatchIntent(ORGANIZATION_ID, intent.actionIntentId));
    expect(dispatched.status).toBe("succeeded");
    expect(dispatched.intent).toMatchObject({ state: "succeeded", revision: 3 });
    expect(dispatched.receipt).toMatchObject({
      outcome: "succeeded",
      amount: usd(18_000),
      providerInstanceId: "provider_simulated_spend",
      actionIntentRef: { type: "action_intent", id: intent.actionIntentId, revision: 2 },
      rawReceiptRef: { type: "provider_operation", id: dispatched.receipt.providerOperationId, revision: 1 },
    });
    const operations = await runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION)
      .find({ organizationId: ORGANIZATION_ID }, { projection: { _id: 0 } }).toArray();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      providerOperationId: dispatched.receipt.providerOperationId,
      idempotencyKey: intent.idempotencyKey,
      amount: usd(18_000),
      vendorId: VENDOR,
      outcome: "applied",
    });

    // A replayed dispatch converges on the stored receipt and never re-delivers.
    const replay = examined(await executor.dispatchIntent(ORGANIZATION_ID, intent.actionIntentId));
    expect(replay.status).toBe("skipped");
    expect(replay.intent.state).toBe("succeeded");
    expect(await runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(1);
    expect(await runtime.db.collection(ACTION_RECEIPTS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(1);

    const settleAudit = await runtime.db.collection(AUDIT_EVENTS_COLLECTION)
      .find({ organizationId: ORGANIZATION_ID, actorId: EXECUTOR_SERVICE_IDENTITY, "subjectRef.id": intent.actionIntentId }).toArray();
    expect(settleAudit.map((event) => event.type)).toEqual(["action.settled"]);
    expect(settleAudit[0]).toMatchObject({
      actorId: "service_action_executor",
      actorRoles: ["executor"],
      commandId: intent.commandId,
      requestId: intent.requestRef.id,
    });
    expect(settleAudit[0]?.correlationId).toBeTypeOf("string");

    // A second receipt for the same provider operation is refused by the store.
    await expect(runtime.db.collection(ACTION_RECEIPTS_COLLECTION).insertOne({
      ...dispatched.receipt,
      receiptId: "receipt_attempted_duplicate",
    })).rejects.toMatchObject({ code: 11000 });
    expect(await runtime.db.collection(ACTION_RECEIPTS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(1);
    expect(ActionReceiptSchema.safeParse(dispatched.receipt).success).toBe(true);
  }, 120_000);

  it("lets exactly one of two racing executors deliver the intent", async () => {
    const { runtime, finance, provider } = await open();
    const { intent } = await approvedRequest(finance, "command_execute_race");
    const first = new MongoActionExecutor(runtime.db, runtime.withTransaction, provider);
    const second = new MongoActionExecutor(runtime.db, runtime.withTransaction, provider);

    const results = (await Promise.all([
      first.dispatchIntent(ORGANIZATION_ID, intent.actionIntentId),
      second.dispatchIntent(ORGANIZATION_ID, intent.actionIntentId),
    ])).map(examined);

    expect(results.filter((result) => result.status === "succeeded")).toHaveLength(1);
    expect(results.filter((result) => result.status === "skipped")).toHaveLength(1);
    expect(await runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(1);
    expect(await runtime.db.collection(ACTION_RECEIPTS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(1);
  }, 120_000);

  it("sweeps the current intent and never delivers a superseded one", async () => {
    const { runtime, finance, executor } = await open();
    const { revision } = await approvedRequest(finance, "command_execute_sweep");
    await finance.amendRequest(employeeContext(), {
      meta: {
        schemaVersion: "1.0.0", organizationId: ORGANIZATION_ID, commandId: "command_execute_amend",
        correlationId: "correlation_command_execute_amend",
        expectedVersions: [{ ref: { type: "request", id: revision.requestId }, expectedRevision: 1 }],
      },
      payload: { requestId: revision.requestId, revisedFullAmount: usd(21_000), reason: "Additional pilot-day lodging" },
    });
    const intents = await finance.listActionIntents(ORGANIZATION_ID, revision.requestId);
    expect(intents.map(({ state, requestRef }) => [state, requestRef.revision])).toEqual([["canceled", 1], ["pending", 2]]);

    const sweep = await executor.runOnce();
    expect(sweep.idle).toBe(false);
    expect(sweep.results.map((result) => result.status)).toEqual(["succeeded"]);
    const receipts = await runtime.db.collection(ACTION_RECEIPTS_COLLECTION)
      .find({ organizationId: ORGANIZATION_ID }, { projection: { _id: 0 } }).toArray();
    expect(receipts).toHaveLength(1);
    expect(ActionReceiptSchema.parse(receipts[0])).toMatchObject({ outcome: "succeeded", amount: usd(21_000) });
    expect(await finance.currentActionIntent(ORGANIZATION_ID, revision.requestId))
      .toMatchObject({ state: "succeeded", requestRef: { revision: 2 } });
    expect(await runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(1);

    expect(await executor.runOnce()).toMatchObject({ idle: true, results: [] });
    expect(await runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(1);
  }, 120_000);

  it("records a declined delivery as failed and retains the reservation", async () => {
    const { runtime, finance, provider, executor } = await open();
    const { intent, revision } = await approvedRequest(finance, "command_execute_declined");
    provider.failureMode = "decline";

    const declined = settled(await executor.dispatchIntent(ORGANIZATION_ID, intent.actionIntentId));
    expect(declined.status).toBe("failed");
    expect(declined.intent.state).toBe("failed");
    expect(declined.receipt.outcome).toBe("failed");

    // The executor owns no financial mutation: the commitment stays outstanding
    // until the financial core handles a failed delivery explicitly.
    expect(CommitmentSchema.parse(await finance.getCommitment(ORGANIZATION_ID, revision.requestId)))
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(18_000) });
    expect(await auditTypes(runtime.db)).toEqual(["action.settled"]);
  }, 120_000);

  it("keeps an ambiguous outcome unresolved until the provider ledger proves it", async () => {
    const { runtime, finance, provider, executor } = await open();
    const { intent, revision } = await approvedRequest(finance, "command_execute_ambiguous");
    provider.failureMode = "timeout_after_apply";

    const unknown = examined(await executor.dispatchIntent(ORGANIZATION_ID, intent.actionIntentId));
    expect(unknown.status).toBe("outcome_unknown");
    expect(unknown.intent.state).toBe("outcome_unknown");
    expect(await runtime.db.collection(ACTION_RECEIPTS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(0);
    expect(CommitmentSchema.parse(await finance.getCommitment(ORGANIZATION_ID, revision.requestId)))
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(18_000) });

    // A blind retry is refused: only reconciliation settles an unknown outcome.
    provider.failureMode = "none";
    const retry = examined(await executor.dispatchIntent(ORGANIZATION_ID, intent.actionIntentId));
    expect(retry).toMatchObject({ status: "skipped", intent: { state: "outcome_unknown" } });
    expect(await runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(1);

    const reconciled = settled(await executor.reconcileIntent(ORGANIZATION_ID, intent.actionIntentId));
    expect(reconciled.status).toBe("succeeded");
    expect(reconciled.receipt).toMatchObject({ outcome: "succeeded", amount: usd(18_000) });
    const operations = await runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION).find({ organizationId: ORGANIZATION_ID }).toArray();
    expect(operations).toHaveLength(1);
    expect(reconciled.receipt.providerOperationId).toBe(operations[0]?.providerOperationId);
    expect(await runtime.db.collection(ACTION_RECEIPTS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(1);
    expect(await auditTypes(runtime.db)).toEqual(["action.outcome_unknown", "action.reconciled"]);

    // The same pass that dispatches also reconciles: nothing is left actionable.
    expect(await executor.runOnce()).toMatchObject({ idle: true, results: [] });
  }, 120_000);

  it("returns an undelivered intent to pending and never resolves uncertainty without proof", async () => {
    const { runtime, finance, provider, executor } = await open();
    const { intent, revision } = await approvedRequest(finance, "command_execute_undelivered");

    provider.failureMode = "unavailable_before_send";
    const unreachable = examined(await executor.dispatchIntent(ORGANIZATION_ID, intent.actionIntentId));
    expect(unreachable.status).toBe("pending");
    expect(unreachable.intent.state).toBe("pending");
    expect(await runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(0);
    expect(await runtime.db.collection(ACTION_RECEIPTS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(0);

    // An unknown outcome whose provider recorded no operation returns to pending:
    // the reservation is retained, never released.
    provider.failureMode = "timeout_without_apply";
    expect(examined(await executor.dispatchIntent(ORGANIZATION_ID, intent.actionIntentId)).status).toBe("outcome_unknown");
    const reconsidered = examined(await executor.reconcileIntent(ORGANIZATION_ID, intent.actionIntentId));
    expect(reconsidered.status).toBe("pending");
    expect(CommitmentSchema.parse(await finance.getCommitment(ORGANIZATION_ID, revision.requestId)))
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(18_000) });
    expect(await auditTypes(runtime.db)).toEqual(["action.delivery_failed", "action.outcome_unknown", "action.reconciled"]);
    const events = await runtime.db.collection(AUDIT_EVENTS_COLLECTION)
      .find({ organizationId: ORGANIZATION_ID, actorId: EXECUTOR_SERVICE_IDENTITY }).sort({ "subjectRef.revision": -1 }).toArray();
    expect(events[0]).toMatchObject({ type: "action.reconciled", details: { disposition: "not_delivered" } });

    provider.failureMode = "none";
    expect(examined(await executor.dispatchIntent(ORGANIZATION_ID, intent.actionIntentId)).status).toBe("succeeded");
    expect(await runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(1);

    // An unreachable provider leaves the intent ambiguous instead of resolving it.
    const ambiguous = await approvedRequest(finance, "command_execute_unreachable_provider", 10_000);
    const deadProvider: SpendProvider = {
      deliver: async (): Promise<ProviderDeliveryResult> => ({ kind: "outcome_unknown", reason: "no response" }),
      lookup: async () => ({ kind: "unavailable", reason: "provider unreachable" }),
    };
    const offline = new MongoActionExecutor(runtime.db, runtime.withTransaction, deadProvider);
    expect(examined(await offline.dispatchIntent(ORGANIZATION_ID, ambiguous.intent.actionIntentId)).status).toBe("outcome_unknown");
    const stillUnknown = examined(await offline.reconcileIntent(ORGANIZATION_ID, ambiguous.intent.actionIntentId));
    expect(stillUnknown).toMatchObject({ status: "outcome_unknown", intent: { state: "outcome_unknown" } });
    expect(await offline.receiptForIntent(ORGANIZATION_ID, ambiguous.intent.actionIntentId)).toBeNull();
  }, 120_000);

  it("refuses documents that violate the collection validators", async () => {
    const { runtime } = await open();
    const receipts = runtime.db.collection(ACTION_RECEIPTS_COLLECTION);
    const operations = runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION);

    await receipts.insertOne(receiptDocument("receipt_validator_ok", "provider_operation_ok"));
    await expect(receipts.insertOne({
      ...receiptDocument("receipt_validator_outcome", "provider_operation_outcome"),
      outcome: "refunded",
    })).rejects.toMatchObject({ code: 121 });
    const { observedAt: _observedAt, ...withoutObservedAt } = receiptDocument("receipt_validator_time", "provider_operation_time");
    await expect(receipts.insertOne({ ...withoutObservedAt })).rejects.toMatchObject({ code: 121 });

    await operations.insertOne(operationDocument("provider_operation_ok", "org_northstar:request_validator:1"));
    await expect(operations.insertOne({
      ...operationDocument("provider_operation_zero", "org_northstar:request_validator:2"),
      amount: { amountMinor: 0, currency: "USD" },
    })).rejects.toMatchObject({ code: 121 });
    await expect(operations.insertOne({
      ...operationDocument("provider_operation_extra", "org_northstar:request_validator:3"),
      lease: { ownerId: "worker_extra" },
    })).rejects.toMatchObject({ code: 121 });
  }, 120_000);

  it("isolates a failing attempt so the rest of the pass still runs", async () => {
    const { runtime, finance, provider } = await open();
    await approvedRequest(finance, "command_execute_isolated_a");
    await approvedRequest(finance, "command_execute_isolated_b", 12_000);
    const exploding: SpendProvider = {
      deliver: async () => {
        throw new Error("simulated provider fault");
      },
      lookup: async () => ({ kind: "absent" }),
    };

    const failing = new MongoActionExecutor(runtime.db, runtime.withTransaction, exploding);
    const sweep = await failing.runOnce();
    expect(sweep).toMatchObject({ idle: false });
    expect(sweep.results.map((result) => result.status)).toEqual(["error", "error"]);
    expect(await runtime.db.collection(ACTION_RECEIPTS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(0);

    // Both attempts left their intents recoverable, and neither blocks the other.
    const healthy = new MongoActionExecutor(runtime.db, runtime.withTransaction, provider);
    const recovered = await healthy.runOnce();
    expect(recovered.results.map((result) => result.status)).toEqual(["succeeded", "succeeded"]);
    expect(await runtime.db.collection(ACTION_RECEIPTS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(2);
    expect(await runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(2);
  }, 120_000);

  it("recovers an intent left dispatching by a crash after the side effect", async () => {
    const { runtime, finance, provider } = await open();
    const { intent, revision } = await approvedRequest(finance, "command_execute_crash");

    // The provider applies the operation and then the worker dies before any
    // receipt is persisted: one provider operation exists, no receipt does.
    const crashing = new MongoActionExecutor(runtime.db, runtime.withTransaction, provider, undefined, {
      afterDelivery: async () => {
        throw new Error("simulated crash after the provider applied the operation");
      },
    });
    await expect(crashing.dispatchIntent(ORGANIZATION_ID, intent.actionIntentId)).rejects.toThrowError("simulated crash");
    const stranded = await runtime.db.collection(ACTION_INTENTS_COLLECTION).findOne({ organizationId: ORGANIZATION_ID }, { projection: { _id: 0 } });
    expect(ActionIntentSchema.parse(stranded)).toMatchObject({ state: "dispatching", revision: 2 });
    expect(await runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(1);
    expect(await runtime.db.collection(ACTION_RECEIPTS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(0);

    // A restarted executor sweeps the stranded intent, re-delivers the same
    // idempotency key, and converges on one operation and one receipt.
    const restarted = new MongoActionExecutor(runtime.db, runtime.withTransaction, provider);
    const sweep = await restarted.runOnce();
    expect(sweep.results.map((result) => result.status)).toEqual(["succeeded"]);
    expect(await runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(1);
    expect(await runtime.db.collection(ACTION_RECEIPTS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID })).toBe(1);

    const receipt = await restarted.receiptForIntent(ORGANIZATION_ID, intent.actionIntentId);
    const operation = await runtime.db.collection(PROVIDER_OPERATIONS_COLLECTION).findOne({ organizationId: ORGANIZATION_ID });
    expect(receipt).toMatchObject({ outcome: "succeeded", providerOperationId: operation?.providerOperationId, amount: usd(18_000) });
    expect(CommitmentSchema.parse(await finance.getCommitment(ORGANIZATION_ID, revision.requestId)))
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(18_000) });
    expect(await restarted.runOnce()).toMatchObject({ idle: true, results: [] });
    expect(await auditTypes(runtime.db)).toEqual(["action.settled"]);
  }, 120_000);
});
