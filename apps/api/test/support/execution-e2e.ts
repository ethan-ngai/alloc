import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionIntentSchema, ActionReceiptSchema, GetRequestResultSchema,
  type ActionIntent, type ActionReceipt,
} from "@alloc/contracts";
import { usd } from "@alloc/financial-rules";
import { MongoSchedulerRepository } from "@alloc/scheduler";
import { startMongoReplicaSet, type MongoTestCluster } from "@alloc/test-support";
import { ACTION_RECEIPTS_COLLECTION, PROVIDER_OPERATIONS_COLLECTION } from "../../src/execution/collections.js";
import { EXECUTOR_SERVICE_IDENTITY } from "../../src/execution/executor.js";
import { AUDIT_EVENTS_COLLECTION } from "../../src/finance/collections.js";
import { connectMongoRuntime, type MongoRuntime } from "../../src/mongo/runtime.js";
import { signTestToken, TEST_JWT_AUDIENCE, TEST_JWT_ISSUER, TEST_JWT_SECRET } from "./app.js";
import { northstarSeed } from "./finance.js";
import {
  baseEnvironment, freePort, spawnProcess, waitForHttp, type RunningProcess,
} from "./process.js";

export const API_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const SERVER_ENTRY = path.join(API_ROOT, "dist", "server.js");
export const WORKER_ENTRY = path.join(API_ROOT, "dist", "execution", "worker.js");
export const ORGANIZATION_ID = "org_northstar";
export const EMPLOYEE = "employee_maya_chen";
export const VENDOR = "vendor_buffalo_hotel";
export const PURPOSE = "Buffalo Beacon pilot trip";
/** Short enough that a killed worker's lease expires inside a test. */
export const SHORT_LEASE_MS = "1500";

export interface ExecutionHarness {
  readonly cluster: MongoTestCluster;
  readonly apiPort: number;
  readonly api: RunningProcess;
  readonly inspector: MongoRuntime;
}

/** Owns a replica set, the API process, and an inspector connection to the same database. */
export async function startExecutionHarness(label: string): Promise<ExecutionHarness> {
  const cluster = await startMongoReplicaSet({ label });
  const inspector = await connectMongoRuntime({ uri: cluster.uri, database: cluster.database });
  await inspector.finance.seed(ORGANIZATION_ID, northstarSeed(ORGANIZATION_ID));
  const apiPort = await freePort();
  const api = spawnProcess(SERVER_ENTRY, {
    cwd: API_ROOT,
    env: {
      ...baseEnvironment(),
      HOST: "127.0.0.1", PORT: String(apiPort), CONDUCTOR_PORT: String(apiPort), LOG_LEVEL: "error",
      MONGO_URI: cluster.uri, MONGO_DATABASE: cluster.database,
      JWT_SECRET: TEST_JWT_SECRET, JWT_ISSUER: TEST_JWT_ISSUER, JWT_AUDIENCE: TEST_JWT_AUDIENCE,
    },
  });
  await waitForHttp(`http://127.0.0.1:${apiPort}/health/live`, 30_000, api);
  return { cluster, apiPort, api, inspector };
}

export async function stopExecutionHarness(harness: ExecutionHarness, stop: (running: RunningProcess) => Promise<void>): Promise<void> {
  await stop(harness.api);
  await harness.inspector.close().catch(() => undefined);
  await harness.cluster.stop();
}

/** Spawns the durable executor worker against the harness database. */
export function startWorker(harness: ExecutionHarness, overrides: Record<string, string> = {}): RunningProcess {
  return spawnProcess(WORKER_ENTRY, {
    cwd: API_ROOT,
    env: {
      ...baseEnvironment(),
      LOG_LEVEL: "info",
      MONGO_URI: harness.cluster.uri, MONGO_DATABASE: harness.cluster.database,
      EXECUTOR_POLL_INTERVAL_MS: "150", EXECUTOR_BATCH_SIZE: "5", EXECUTOR_LEASE_MS: SHORT_LEASE_MS,
      ...overrides,
    },
  });
}

export function employeeToken(): Promise<string> {
  return signTestToken({ expiresInSeconds: 3_600, claims: { sub: EMPLOYEE, org: ORGANIZATION_ID, roles: ["employee"] } });
}

/** Creates a request policy approves, which is what produces the pending action intent. */
export async function createApprovedRequest(
  harness: ExecutionHarness,
  commandId: string,
  amountMinor: number,
  token: string,
): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${harness.apiPort}/v1/organizations/${ORGANIZATION_ID}/requests`, {
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
  if (body.data.evaluationState !== "approved") {
    throw new Error(`request ${body.data.requestId} evaluated as ${String(body.data.evaluationState)}`);
  }
  return body.data.requestId;
}

export async function readRequest(harness: ExecutionHarness, requestId: string, token: string) {
  const response = await fetch(
    `http://127.0.0.1:${harness.apiPort}/v1/organizations/${ORGANIZATION_ID}/requests/${requestId}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const parsed = GetRequestResultSchema.parse(await response.json());
  if (!parsed.ok) {
    throw new Error(`unexpected request read: ${response.status} ${JSON.stringify(parsed.error)}`);
  }
  return parsed.data;
}

export async function intentFor(harness: ExecutionHarness, requestId: string): Promise<ActionIntent> {
  const intent = await harness.inspector.finance.currentActionIntent(ORGANIZATION_ID, requestId);
  if (intent === null) {
    throw new Error(`request ${requestId} has no action intent`);
  }
  return intent;
}

export async function pendingIntent(harness: ExecutionHarness, requestId: string): Promise<ActionIntent> {
  const intent = await intentFor(harness, requestId);
  if (intent.state !== "pending") {
    throw new Error(`expected a pending intent, found ${intent.state}`);
  }
  return intent;
}

export function intentState(harness: ExecutionHarness, requestId: string): Promise<ActionIntent["state"]> {
  return intentFor(harness, requestId).then((intent) => intent.state);
}

export async function receiptsFor(harness: ExecutionHarness, requestId: string): Promise<ActionReceipt[]> {
  const intent = await intentFor(harness, requestId);
  const documents = await harness.inspector.db.collection(ACTION_RECEIPTS_COLLECTION)
    .find({ organizationId: ORGANIZATION_ID, "actionIntentRef.id": intent.actionIntentId }, { projection: { _id: 0 } })
    .toArray();
  return documents.map((document) => ActionReceiptSchema.parse(document));
}

export function providerOperations(harness: ExecutionHarness, idempotencyKey: string): Promise<number> {
  return harness.inspector.db.collection(PROVIDER_OPERATIONS_COLLECTION)
    .countDocuments({ organizationId: ORGANIZATION_ID, idempotencyKey });
}

/** The executor's own audit trail, ordered by the intent revision it records. */
export async function auditTypes(harness: ExecutionHarness, actionIntentId: string): Promise<string[]> {
  const events = await harness.inspector.db.collection(AUDIT_EVENTS_COLLECTION)
    .find({ organizationId: ORGANIZATION_ID, actorId: EXECUTOR_SERVICE_IDENTITY, "subjectRef.id": actionIntentId })
    .sort({ "subjectRef.revision": 1 })
    .toArray();
  return events.map((event) => String(event.type));
}

/** Durable jobs as the worker sees them. */
export function schedulerJobs(harness: ExecutionHarness): MongoSchedulerRepository {
  return new MongoSchedulerRepository(harness.inspector.db);
}

export async function storedIntents(harness: ExecutionHarness, actionIntentId: string): Promise<ActionIntent | null> {
  const document = await harness.inspector.db.collection("financial_action_intents")
    .findOne({ organizationId: ORGANIZATION_ID, actionIntentId }, { projection: { _id: 0 } });
  return document === null ? null : ActionIntentSchema.parse(document);
}
