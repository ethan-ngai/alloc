import path from "node:path";
import { fileURLToPath } from "node:url";
import { ActionReceiptSchema, GetRequestResultSchema, type ActionIntent, type ActionReceipt } from "@alloc/contracts";
import { usd } from "@alloc/financial-rules";
import { startMongoReplicaSet, type MongoTestCluster } from "@alloc/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACTION_RECEIPTS_COLLECTION, PROVIDER_OPERATIONS_COLLECTION } from "../../src/execution/collections.js";
import { AUDIT_EVENTS_COLLECTION } from "../../src/finance/collections.js";
import { connectMongoRuntime, type MongoRuntime } from "../../src/mongo/runtime.js";
import { signTestToken, TEST_JWT_AUDIENCE, TEST_JWT_ISSUER, TEST_JWT_SECRET } from "../support/app.js";
import { northstarSeed } from "../support/finance.js";
import {
  baseEnvironment, freePort, spawnProcess, stopProcess, waitForExit, waitForHttp, waitForSuccess, type RunningProcess,
} from "../support/process.js";

const API_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER_ENTRY = path.join(API_ROOT, "dist", "server.js");
const WORKER_ENTRY = path.join(API_ROOT, "dist", "execution", "worker.js");
const ORGANIZATION_ID = "org_northstar";
const EMPLOYEE = "employee_maya_chen";
const VENDOR = "vendor_buffalo_hotel";
const PURPOSE = "Buffalo Beacon pilot trip";

let cluster: MongoTestCluster;
let apiPort: number;
let api: RunningProcess;
let inspector: MongoRuntime | undefined;

beforeAll(async () => {
  cluster = await startMongoReplicaSet({ label: "execution-e2e" });
  inspector = await connectMongoRuntime({ uri: cluster.uri, database: cluster.database });
  await inspector.finance.seed(ORGANIZATION_ID, northstarSeed(ORGANIZATION_ID));
  apiPort = await freePort();
  api = startApi();
  await waitForHttp(`http://127.0.0.1:${apiPort}/health/live`, 30_000, api);
}, 240_000);

afterAll(async () => {
  await stopProcess(api);
  await inspector?.close().catch(() => undefined);
  await cluster?.stop();
});

describe("simulated action delivery end to end", () => {
  it("approves, dispatches, crashes after the provider side effect, restarts, and reconciles one action", async () => {
    const token = await signTestToken({ expiresInSeconds: 3_600, claims: { sub: EMPLOYEE, org: ORGANIZATION_ID, roles: ["employee"] } });
    const requestId = await createRequest("command_e2e_exec_crash", 18_000, token);
    const intent = await pendingIntent(requestId);

    // The worker applies the provider operation and is killed before it can
    // persist a receipt, which is the crash-after-side-effect window.
    const crashing = startWorker({ EXECUTOR_FAULT: "crash_after_provider_apply" });
    await waitForExit(crashing.child, 30_000);
    expect(await providerOperations(intent.idempotencyKey)).toBe(1);
    expect(await receiptsFor(requestId)).toHaveLength(0);
    expect((await intentFor(requestId)).state).toBe("dispatching");

    // No receipt may mean no release: the commitment is still outstanding.
    expect((await getRequest(requestId, token)).commitment)
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(18_000) });

    // The restarted worker recovers the stranded intent and settles it against
    // the single operation the provider already recorded.
    const restarted = startWorker({});
    await waitForSuccess(async () => (await intentFor(requestId)).state === "succeeded", 30_000, "the recovered intent to succeed", restarted);
    await stopProcess(restarted);

    const receipts = await receiptsFor(requestId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      outcome: "succeeded",
      amount: usd(18_000),
      providerInstanceId: "provider_simulated_spend",
      actionIntentRef: { type: "action_intent", id: intent.actionIntentId },
    });
    const operations = await inspector!.db.collection(PROVIDER_OPERATIONS_COLLECTION).find({ organizationId: ORGANIZATION_ID }).toArray();
    expect(operations).toHaveLength(1);
    expect(receipts[0]?.providerOperationId).toBe(operations[0]?.providerOperationId);
    expect((await getRequest(requestId, token)).commitment)
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(18_000) });
    expect(await auditTypes(intent.actionIntentId)).toEqual(["action.settled"]);
  }, 120_000);

  it("resolves an ambiguous provider timeout by reconciliation instead of a second delivery", async () => {
    const token = await signTestToken({ expiresInSeconds: 3_600, claims: { sub: EMPLOYEE, org: ORGANIZATION_ID, roles: ["employee"] } });
    const requestId = await createRequest("command_e2e_exec_timeout", 12_000, token);
    const intent = await pendingIntent(requestId);

    const worker = startWorker({ SIMULATED_PROVIDER_FAILURE_MODE: "timeout_after_apply" });
    await waitForSuccess(async () => (await intentFor(requestId)).state === "succeeded", 30_000, "the reconciled intent to succeed", worker);
    await stopProcess(worker);

    expect(await providerOperations(intent.idempotencyKey)).toBe(1);
    const receipts = await receiptsFor(requestId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: "succeeded", amount: usd(12_000) });
    expect(await auditTypes(intent.actionIntentId)).toEqual(["action.outcome_unknown", "action.reconciled"]);
  }, 120_000);

  it("keeps an undelivered intent pending until the provider accepts it", async () => {
    const token = await signTestToken({ expiresInSeconds: 3_600, claims: { sub: EMPLOYEE, org: ORGANIZATION_ID, roles: ["employee"] } });
    const requestId = await createRequest("command_e2e_exec_offline", 9_000, token);
    const intent = await pendingIntent(requestId);

    const offline = startWorker({ SIMULATED_PROVIDER_FAILURE_MODE: "unavailable_before_send" });
    await waitForSuccess(
      async () => (await auditTypes(intent.actionIntentId)).includes("action.delivery_failed"),
      30_000,
      "a failed delivery attempt",
      offline,
    );
    await stopProcess(offline);

    expect(await providerOperations(intent.idempotencyKey)).toBe(0);
    expect(await receiptsFor(requestId)).toHaveLength(0);
    expect((await getRequest(requestId, token)).commitment)
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(9_000) });

    const online = startWorker({});
    await waitForSuccess(async () => (await intentFor(requestId)).state === "succeeded", 30_000, "the retried intent to succeed", online);
    await stopProcess(online);

    expect(await providerOperations(intent.idempotencyKey)).toBe(1);
    expect(await receiptsFor(requestId)).toHaveLength(1);
    expect((await getRequest(requestId, token)).commitment)
      .toMatchObject({ state: "outstanding", outstandingAmount: usd(9_000) });
  }, 120_000);
});

function startApi(): RunningProcess {
  return spawnProcess(SERVER_ENTRY, {
    cwd: API_ROOT,
    env: {
      ...baseEnvironment(),
      HOST: "127.0.0.1", PORT: String(apiPort), CONDUCTOR_PORT: String(apiPort), LOG_LEVEL: "error",
      MONGO_URI: cluster.uri, MONGO_DATABASE: cluster.database,
      JWT_SECRET: TEST_JWT_SECRET, JWT_ISSUER: TEST_JWT_ISSUER, JWT_AUDIENCE: TEST_JWT_AUDIENCE,
    },
  });
}

/** The interim single-flight poller; 5A's scheduler will drive the executor instead. */
function startWorker(overrides: Record<string, string>): RunningProcess {
  return spawnProcess(WORKER_ENTRY, {
    cwd: API_ROOT,
    env: {
      ...baseEnvironment(),
      LOG_LEVEL: "info",
      MONGO_URI: cluster.uri, MONGO_DATABASE: cluster.database,
      EXECUTOR_POLL_INTERVAL_MS: "150", EXECUTOR_BATCH_SIZE: "5",
      ...overrides,
    },
  });
}

async function createRequest(commandId: string, amountMinor: number, token: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/organizations/${ORGANIZATION_ID}/requests`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
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
          { type: "project", id: "project_beacon" },
        ],
      },
    }),
  });
  const body = await response.json() as { ok: boolean; data?: { requestId?: string; evaluationState?: string } };
  if (!response.ok || body.ok !== true || typeof body.data?.requestId !== "string") {
    throw new Error(`request creation failed: ${response.status} ${JSON.stringify(body)}`);
  }
  expect(body.data.evaluationState).toBe("approved");
  return body.data.requestId;
}

async function getRequest(requestId: string, token: string) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/organizations/${ORGANIZATION_ID}/requests/${requestId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const parsed = GetRequestResultSchema.parse(await response.json());
  if (!parsed.ok) {
    throw new Error(`unexpected request read: ${response.status} ${JSON.stringify(parsed.error)}`);
  }
  return parsed.data;
}

async function pendingIntent(requestId: string): Promise<ActionIntent> {
  const intent = await intentFor(requestId);
  expect(intent).toMatchObject({ state: "pending", providerInstanceId: "provider_simulated_spend" });
  return intent;
}

async function intentFor(requestId: string): Promise<ActionIntent> {
  const intent = await inspector!.finance.currentActionIntent(ORGANIZATION_ID, requestId);
  if (intent === null) {
    throw new Error(`request ${requestId} has no action intent`);
  }
  return intent;
}

async function receiptsFor(requestId: string): Promise<ActionReceipt[]> {
  const intent = await intentFor(requestId);
  const documents = await inspector!.db.collection(ACTION_RECEIPTS_COLLECTION)
    .find({ organizationId: ORGANIZATION_ID, "actionIntentRef.id": intent.actionIntentId }, { projection: { _id: 0 } }).toArray();
  return documents.map((document) => ActionReceiptSchema.parse(document));
}

/** The executor's audit trail, ordered by the intent revision it records. */
async function auditTypes(actionIntentId: string): Promise<string[]> {
  const events = await inspector!.db.collection(AUDIT_EVENTS_COLLECTION)
    .find({ organizationId: ORGANIZATION_ID, actorId: "service_action_executor", "subjectRef.id": actionIntentId })
    .sort({ "subjectRef.revision": 1 }).toArray();
  return events.map((event) => String(event.type));
}

function providerOperations(idempotencyKey: string): Promise<number> {
  return inspector!.db.collection(PROVIDER_OPERATIONS_COLLECTION).countDocuments({ organizationId: ORGANIZATION_ID, idempotencyKey });
}
