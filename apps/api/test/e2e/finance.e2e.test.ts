import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMongoReplicaSet, type MongoTestCluster } from "@alloc/test-support";
import {
  AmendRequestResultSchema, CreateRequestResultSchema, DecideReviewResultSchema, GetRequestResultSchema, RecordPostingResultSchema,
} from "@alloc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMongoRuntime, type MongoRuntime } from "../../src/mongo/runtime.js";
import { signTestToken, TEST_JWT_AUDIENCE, TEST_JWT_ISSUER, TEST_JWT_SECRET } from "../support/app.js";
import { loadNorthstarFixture, northstarSeed } from "../support/finance.js";
import { baseEnvironment, freePort, spawnProcess, stopProcess, waitForHttp, type RunningProcess } from "../support/process.js";

const API_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER_ENTRY = path.join(API_ROOT, "dist", "server.js");
const ORGANIZATION_ID = "org_northstar";
const EMPLOYEE = "employee_maya_chen";
const FINANCE = "employee_avery_finance";

let cluster: MongoTestCluster;
let apiPort: number;
let api: RunningProcess;
let inspector: MongoRuntime | undefined;

beforeAll(async () => {
  cluster = await startMongoReplicaSet({ label: "finance-e2e" });
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

describe("financial HTTP end to end on the Northstar fixture", () => {
  it("runs $180 → +$30 auto-approval → +$30 review → finance approval → matched posting", async () => {
    const employee = await signTestToken({ expiresInSeconds: 3_600, claims: { sub: EMPLOYEE, org: ORGANIZATION_ID, roles: ["employee"] } });
    const finance = await signTestToken({ expiresInSeconds: 3_600, claims: { sub: FINANCE, org: ORGANIZATION_ID, roles: ["finance_manager"] } });

    const created = await post(`/v1/organizations/${ORGANIZATION_ID}/requests`, {
      meta: command("command_e2e_create", []),
      payload: {
        requesterId: EMPLOYEE, purpose: "Buffalo Beacon pilot trip", fullAmount: money(18_000), categoryId: "category_travel",
        vendorId: "vendor_buffalo_hotel", projectId: "project_beacon",
        scopes: [
          { type: "organization", id: ORGANIZATION_ID },
          { type: "department", id: "department_field_engineering" },
          { type: "project", id: "project_beacon" },
        ],
      },
    }, employee);
    expect(created.status).toBe(200);
    expect(CreateRequestResultSchema.safeParse(created.body).success).toBe(true);
    const requestId = (created.body.data as { requestId: string }).requestId;
    expect(created.body.data).toMatchObject({ evaluationState: "approved", fullAmount: money(18_000) });
    expect((await getRequest(requestId, employee)).commitment).toMatchObject({ outstandingAmount: money(18_000) });

    const firstAmendment = await post(`/v1/organizations/${ORGANIZATION_ID}/requests/${requestId}/amendments`, {
      meta: command("command_e2e_amend1", [{ ref: { type: "request", id: requestId }, expectedRevision: 1 }]),
      payload: { requestId, revisedFullAmount: money(21_000), reason: "Additional pilot-day lodging" },
    }, employee);
    expect(firstAmendment.status).toBe(200);
    expect(AmendRequestResultSchema.safeParse(firstAmendment.body).success).toBe(true);
    expect(firstAmendment.body.data).toMatchObject({ request: { revision: 2, evaluationState: "approved" }, decision: { outcome: "approved" } });
    expect((await getRequest(requestId, employee)).commitment).toMatchObject({ amount: money(21_000), outstandingAmount: money(21_000) });

    const secondAmendment = await post(`/v1/organizations/${ORGANIZATION_ID}/requests/${requestId}/amendments`, {
      meta: command("command_e2e_amend2", [{ ref: { type: "request", id: requestId }, expectedRevision: 2 }]),
      payload: { requestId, revisedFullAmount: money(24_000), reason: "Second additional lodging day" },
    }, employee);
    expect(secondAmendment.status).toBe(200);
    expect(AmendRequestResultSchema.safeParse(secondAmendment.body).success).toBe(true);
    expect(secondAmendment.body.data).toMatchObject({ request: { revision: 3, evaluationState: "review_required" } });
    expect((secondAmendment.body.data as { decision: { reasonCodes: string[] } }).decision.reasonCodes).toContain("CUMULATIVE_INCREASE_LIMIT_EXCEEDED");
    const whileReviewing = await getRequest(requestId, employee);
    expect(whileReviewing.commitment).toMatchObject({ amount: money(21_000), outstandingAmount: money(21_000) });

    const review = await post(`/v1/organizations/${ORGANIZATION_ID}/requests/${requestId}/reviews`, {
      meta: command("command_e2e_review", [{ ref: { type: "request", id: requestId }, expectedRevision: 3 }]),
      payload: { requestId, requestRevision: 3, outcome: "approved", rationale: "Approved against the cumulative allowance" },
    }, finance);
    expect(review.status).toBe(200);
    expect(DecideReviewResultSchema.safeParse(review.body).success).toBe(true);
    expect(review.body.data).toMatchObject({ decision: { outcome: "approved", reasonCodes: ["AUTHORIZED_HUMAN_EXCEPTION"] }, commitment: { outstandingAmount: money(24_000) } });

    const approvedView = await getRequest(requestId, employee);
    expect(approvedView.request).toMatchObject({ revision: 3, evaluationState: "review_required" });
    expect(approvedView.decisions).toHaveLength(4);
    expect(approvedView.commitment).toMatchObject({ amount: money(24_000), outstandingAmount: money(24_000), state: "outstanding" });

    const intents = await inspector!.finance.listActionIntents(ORGANIZATION_ID, requestId);
    expect(intents.filter((intent) => intent.state === "pending")).toHaveLength(1);
    expect(intents.filter((intent) => intent.state === "canceled")).toHaveLength(2);
    const current = await inspector!.finance.currentActionIntent(ORGANIZATION_ID, requestId);
    expect(current).toMatchObject({
      requestRef: { revision: 3 }, state: "pending", providerInstanceId: "provider_simulated_spend",
      action: { type: "simulate_purchase", amount: money(24_000), vendorId: "vendor_buffalo_hotel" },
    });
    const grants = await inspector!.finance.listApprovalGrants(ORGANIZATION_ID, requestId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ approverId: FINANCE, authorityRole: "finance_manager", exactAmount: money(24_000), policyRef: { id: "policy_travel", revision: 1 } });

    const budgetBeforePosting = await inspector!.finance.getBudgetAccount(ORGANIZATION_ID, "budget_field_travel");
    expect(budgetBeforePosting).toMatchObject({ recognizedSpend: money(858_060), outstandingCommitments: money(24_000) });

    const fixturePosting = loadNorthstarFixture().scenario.posting;
    const commitment = await inspector!.finance.getCommitment(ORGANIZATION_ID, requestId);
    const { organizationId: _organizationId, schemaVersion: _schemaVersion, ...postingPayload } = fixturePosting;
    const posting = await post(`/v1/organizations/${ORGANIZATION_ID}/postings`, {
      meta: command("command_e2e_posting", []),
      payload: { ...postingPayload, commitmentRef: { type: "commitment", id: commitment!.commitmentId, revision: commitment!.revision } },
    }, finance);
    expect(posting.status).toBe(200);
    expect(RecordPostingResultSchema.safeParse(posting.body).success).toBe(true);

    const posted = await getRequest(requestId, employee);
    expect(posted.commitment).toMatchObject({ state: "posted", outstandingAmount: money(0) });
    const budgetAfterPosting = await inspector!.finance.getBudgetAccount(ORGANIZATION_ID, "budget_field_travel");
    expect(budgetAfterPosting).toMatchObject({ recognizedSpend: money(882_060), outstandingCommitments: money(0), available: money(76_000) });
    // The matched posting moved exposure from commitment to spend without changing the total.
    expect(budgetBeforePosting!.recognizedSpend.amountMinor + budgetBeforePosting!.outstandingCommitments.amountMinor)
      .toBe(budgetAfterPosting!.recognizedSpend.amountMinor + budgetAfterPosting!.outstandingCommitments.amountMinor);
    expect(budgetAfterPosting!.revision).toBeGreaterThan(budgetBeforePosting!.revision);

    const revisions = await inspector!.finance.listRequestRevisions(ORGANIZATION_ID, requestId);
    expect(revisions.map((revision) => revision.revision)).toEqual([1, 2, 3]);
    const audit = await inspector!.finance.listAuditEvents(ORGANIZATION_ID, requestId);
    expect(audit.map((event) => event.type)).toEqual(expect.arrayContaining(["request.created", "request.amended", "decision.recorded", "review.approved"]));
    expect(audit.every((event) => event.actorId.length > 0 && event.correlationId !== undefined)).toBe(true);
  }, 120_000);

  it("rejects an unauthenticated command and an employee deciding a review", async () => {
    const unauthenticated = await fetch(`http://127.0.0.1:${apiPort}/v1/organizations/${ORGANIZATION_ID}/requests/request_any/reviews`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(unauthenticated.status).toBe(401);

    const employee = await signTestToken({ expiresInSeconds: 3_600, claims: { sub: EMPLOYEE, org: ORGANIZATION_ID, roles: ["employee"] } });
    const denied = await post(`/v1/organizations/${ORGANIZATION_ID}/requests/request_any/reviews`, {
      meta: command("command_e2e_denied_review", []),
      payload: { requestId: "request_any", requestRevision: 1, outcome: "approved", rationale: "Self approval" },
    }, employee);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ ok: false, error: { code: "AUTHORITY_DENIED" } });
  });
});

function command(commandId: string, expectedVersions: unknown[]) {
  return {
    schemaVersion: "1.0.0", organizationId: ORGANIZATION_ID, commandId, correlationId: `correlation_${commandId}`, expectedVersions,
  };
}

function money(amountMinor: number) {
  return { amountMinor, currency: "USD" };
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

async function post(pathname: string, payload: unknown, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

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
