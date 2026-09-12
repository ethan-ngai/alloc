import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CompanyEntitySchema, operationResult, type SourceDelivery } from "@alloc/contracts";
import { readFileSync } from "node:fs";
import { startMongoReplicaSet, startMongoStandalone, type MongoTestCluster } from "@alloc/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORGANIZATIONS_COLLECTION } from "../../src/mongo/organizations.js";
import { connectMongoRuntime } from "../../src/mongo/runtime.js";
import { signTestToken, TEST_JWT_AUDIENCE, TEST_JWT_ISSUER, TEST_JWT_SECRET } from "../support/app.js";
import { juniperOrganizationId, NORTHSTAR_ORGANIZATION_ID, northstarOrganization } from "../support/organizations.js";

const API_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER_ENTRY = path.join(API_ROOT, "dist", "server.js");
const ORGANIZATION_PATH = `/v1/organizations/${NORTHSTAR_ORGANIZATION_ID}`;
const OrganizationResultSchema = operationResult(CompanyEntitySchema);
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../packages/company-fixtures/fixtures/northstar.json", import.meta.url)), "utf8")) as { entities: never[]; manifest: { mappings: never[] }; relationships: never[]; deliveries: SourceDelivery[] };

interface RunningApi {
  readonly child: ChildProcess;
  /** Combined process output, used only to explain a failure. */
  output(): string;
}

let cluster: MongoTestCluster;
let apiPort: number;
let api: RunningApi;
const spawned: ChildProcess[] = [];

beforeAll(async () => {
  cluster = await startMongoReplicaSet({ label: "e2e" });
  await seedOrganization();
  await seedImports();
  apiPort = await freePort();
  api = startApi();
  await waitForHttp(livenessUrl(apiPort), 30_000, api);
}, 240_000);

afterAll(async () => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 10_000).catch(() => child.kill("SIGKILL"));
    }
  }
  await cluster?.stop();
});

describe("HTTP end to end", () => {
  it("answers liveness and readiness on a real listening process", async () => {
    const live = await get("/health/live");
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ ok: true, data: { status: "live" } });
    expect(live.headers.get("x-correlation-id")).toBe(live.body.correlationId);

    const ready = await get("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ ok: true, data: { status: "ready" } });
  });

  it("rejects unauthenticated access with the shared error contract", async () => {
    const response = await get(ORGANIZATION_PATH);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ ok: false, error: { code: "ACCESS_DENIED", retryable: false } });
    expect(response.headers.get("x-correlation-id")).toBe(response.body.correlationId);
  });

  it("returns the seeded organization for a valid token", async () => {
    const token = await signTestToken({ expiresInSeconds: 3_600 });
    const response = await get(ORGANIZATION_PATH, { authorization: `Bearer ${token}` });

    expect(response.status).toBe(200);
    const parsed = OrganizationResultSchema.parse(response.body);
    if (!parsed.ok) {
      throw new Error("expected a successful envelope");
    }
    expect(parsed.data).toEqual(northstarOrganization);
  });

  it("blocks cross-tenant access without searching the other tenant", async () => {
    const northstarToken = await signTestToken({ expiresInSeconds: 3_600 });
    const crossTenant = await get(`/v1/organizations/${juniperOrganizationId}`, {
      authorization: `Bearer ${northstarToken}`,
    });
    expect(crossTenant.status).toBe(403);
    expect(crossTenant.body).toMatchObject({ ok: false, error: { code: "ACCESS_DENIED" } });

    const juniperToken = await signTestToken({ expiresInSeconds: 3_600, claims: { org: juniperOrganizationId } });
    const otherTenant = await get(ORGANIZATION_PATH, { authorization: `Bearer ${juniperToken}` });
    expect(otherTenant.status).toBe(403);

    const ownMissingTenant = await get(`/v1/organizations/${juniperOrganizationId}`, {
      authorization: `Bearer ${juniperToken}`,
    });
    expect(ownMissingTenant.status).toBe(404);
    expect(ownMissingTenant.body).not.toContain(NORTHSTAR_ORGANIZATION_ID);
  });

  it("restarts only the API and keeps the Mongo-backed record", async () => {
    api.child.kill("SIGTERM");
    expect(await waitForExit(api.child, 20_000)).toBe(0);

    await expect(fetch(livenessUrl(apiPort), { signal: AbortSignal.timeout(1_000) })).rejects.toThrowError();

    api = startApi();
    await waitForHttp(livenessUrl(apiPort), 30_000, api);

    const ready = await get("/health/ready");
    expect(ready.status).toBe(200);

    const token = await signTestToken({ expiresInSeconds: 3_600 });
    const response = await get(ORGANIZATION_PATH, { authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, data: { displayName: "Northstar Fieldworks" } });
  });

  it("imports, retrieves, and safely replays a source revision over HTTP", async () => {
    const token = await signTestToken({ expiresInSeconds: 3_600 });
    const delivery = fixture.deliveries[0]!;
    const first = await post("/v1/organizations/org_northstar/imports", command(delivery), token);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, data: { disposition: "accepted" } });
    const replay = { ...delivery, deliveryId: `${delivery.deliveryId}-replay`, observedAt: "2026-12-01T00:00:00.000Z", provenance: { ...delivery.provenance, observedAt: "2026-12-01T00:00:00.000Z" } };
    expect((await post("/v1/organizations/org_northstar/imports", command(replay), token)).body).toMatchObject({ ok: true, data: { disposition: "duplicate" } });
    const postings = await get("/v1/organizations/org_northstar/imports/postings", { authorization: `Bearer ${token}` });
    expect(postings.body).toMatchObject({ ok: true, data: [{ postingId: (delivery.payload.posting as { postingId: string }).postingId }] });
    expect((postings.body.data as unknown[])).toHaveLength(1);
  });

  it("retrieves food context over HTTP without a project", async () => {
    const token = await signTestToken({ expiresInSeconds: 3_600 });
    const delivery = fixture.deliveries.find((item) => (item.payload.posting as { scopes: Array<{ id: string }> } | undefined)?.scopes.some((scope) => scope.id === "category_food"))!;
    await post("/v1/organizations/org_northstar/imports", command(delivery), token);
    const response = await post("/v1/organizations/org_northstar/memory/query", memoryQuery("food", [{ type: "category", id: "category_food" }]), token);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, data: { organizationId: "org_northstar", evidence: [expect.any(Object)] } });
    expect((response.body.data as { facts: Array<{ ref: { type: string } }> }).facts.some((fact) => fact.ref.type === "posting")).toBe(true);

    const denied = await post("/v1/organizations/org_juniper/memory/query", memoryQuery("food", [{ type: "category", id: "category_food" }]), token);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ ok: false, error: { code: "ACCESS_DENIED" } });

    const malformedCursor = await post("/v1/organizations/org_northstar/memory/query", memoryQuery("food", [{ type: "category", id: "category_food" }], "not-a-cursor"), token);
    expect(malformedCursor.status).toBe(400);
    expect(malformedCursor.body).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("traverses verified context through an authenticated, bounded endpoint", async () => {
    const token = await signTestToken({ expiresInSeconds: 3_600 });
    const response = await post("/v1/organizations/org_northstar/context/graph", graphQuery(), token);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, data: { subjectRef: { id: "employee_maya_chen" }, relationships: [expect.objectContaining({ verification: "verified" })], evidenceRefs: [expect.any(Object)] } });
    const denied = await post("/v1/organizations/org_juniper/context/graph", graphQuery(), token);
    expect(denied.status).toBe(403);
  });
});

describe("startup refusals", () => {
  it("rejects malformed configuration before listening", async () => {
    const port = await freePort();
    const secret = "too-short-secret-value";
    const refused = startApi({ port, env: { JWT_SECRET: secret }, keep: false });

    expect(await waitForExit(refused.child, 20_000)).toBe(1);
    expect(refused.output()).toContain("JWT_SECRET must be at least 32 bytes");
    expect(refused.output()).not.toContain(secret);
    await expect(fetch(livenessUrl(port), { signal: AbortSignal.timeout(1_000) })).rejects.toThrowError();
  });

  it("refuses to start against a standalone MongoDB deployment", async () => {
    const standalone = await startMongoStandalone({ label: "e2e-standalone" });
    try {
      const port = await freePort();
      const refused = startApi({ port, mongoUri: standalone.uri, database: standalone.database, keep: false });

      expect(await waitForExit(refused.child, 30_000)).toBe(1);
      expect(refused.output()).toContain("replica set is required");
      await expect(fetch(livenessUrl(port), { signal: AbortSignal.timeout(1_000) })).rejects.toThrowError();
    } finally {
      await standalone.stop();
    }
  });
});

function startApi(options: { port?: number; mongoUri?: string; database?: string; env?: Record<string, string>; keep?: boolean } = {}): RunningApi {
  const port = options.port ?? apiPort;
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: API_ROOT,
    env: {
      ...baseEnvironment(),
      HOST: "127.0.0.1",
      PORT: String(port),
      CONDUCTOR_PORT: String(port),
      LOG_LEVEL: "error",
      MONGO_URI: options.mongoUri ?? cluster.uri,
      MONGO_DATABASE: options.database ?? cluster.database,
      JWT_SECRET: TEST_JWT_SECRET,
      JWT_ISSUER: TEST_JWT_ISSUER,
      JWT_AUDIENCE: TEST_JWT_AUDIENCE,
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  if (options.keep ?? true) {
    spawned.push(child);
  }
  return { child, output: () => output };
}

function baseEnvironment(): NodeJS.ProcessEnv {
  // CONDUCTOR_PORT and PORT are stripped so each spawned process binds exactly
  // the port this test allocated.
  const { CONDUCTOR_PORT: _conductorPort, PORT: _port, ...rest } = process.env;
  return rest;
}

async function seedOrganization(): Promise<void> {
  const runtime = await connectMongoRuntime({ uri: cluster.uri, database: cluster.database });
  try {
    await runtime.db.collection(ORGANIZATIONS_COLLECTION).insertOne({ ...northstarOrganization });
  } finally {
    await runtime.close();
  }
}

async function seedImports(): Promise<void> {
  const runtime = await connectMongoRuntime({ uri: cluster.uri, database: cluster.database });
  try {
    await runtime.imports.seedEntities(fixture.entities);
    await runtime.imports.seedMappings(fixture.manifest.mappings);
    await runtime.graph.seedRelationships(fixture.relationships);
  } finally {
    await runtime.close();
  }
}

async function get(pathname: string, headers: Record<string, string> = {}): Promise<{
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}> {
  const response = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, { headers });
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers };
}

function livenessUrl(port: number): string {
  return `http://127.0.0.1:${port}/health/live`;
}

async function post(pathname: string, payload: unknown, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function command(delivery: SourceDelivery) {
  const { organizationId: _organizationId, schemaVersion: _schemaVersion, ...payload } = delivery;
  return { meta: { schemaVersion: "1.0.0", organizationId: "org_northstar", commandId: "command_import_e2e", correlationId: "correlation_import_e2e", expectedVersions: [] }, payload };
}

function memoryQuery(query: string, scopes: Array<{ type: string; id: string }>, cursor?: string) {
  return { meta: { schemaVersion: "1.0.0", organizationId: "org_northstar", correlationId: "correlation_memory_e2e" }, payload: { query, scopes, page: { limit: 25, ...(cursor === undefined ? {} : { cursor }) } } };
}

function graphQuery() {
  return { meta: { schemaVersion: "1.0.0", organizationId: "org_northstar", correlationId: "correlation_graph_e2e" }, payload: { subjectRef: { type: "entity", id: "employee_maya_chen" }, relationshipTypes: [], maxHops: 2, maxEntities: 50 } };
}

async function waitForHttp(url: string, timeoutMs: number, running: RunningApi): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    if (running.child.exitCode !== null) {
      throw new Error(`api exited with code ${running.child.exitCode}\n${running.output()}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`api did not answer ${url} within ${timeoutMs}ms\n${running.output()}`);
    }
    await sleep(200);
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process ${child.pid ?? "unknown"} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
