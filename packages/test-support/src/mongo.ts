import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { MongoClient } from "mongodb";
import { assertDockerAvailable, docker, tryDocker } from "./docker.js";

/**
 * Pinned MongoDB image; the runtime refuses deployments that are not replica sets.
 * 8.0.30 aborts on Linux kernel 6.19+ (SERVER-121912), which covers current Docker
 * Desktop VMs, so the default is a release that starts there. Override with
 * ALLOC_MONGO_IMAGE to test against another server build.
 */
export const MONGO_TEST_IMAGE = process.env["ALLOC_MONGO_IMAGE"] ?? "mongo:8.2.4";
/** Replica-set name used by the owned single-member test cluster. */
export const MONGO_TEST_REPLICA_SET = "alloctest";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_START_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 250;
/** Docker publishes a port we reserved; retry when another process claimed it. */
const PORT_ATTEMPTS = 5;

export interface StartMongoOptions {
  /** Short label used in the container name; defaults to the topology name. */
  readonly label?: string;
  readonly image?: string;
  /** Database name; defaults to a unique per-suite name. */
  readonly database?: string;
  readonly startTimeoutMs?: number;
}

/**
 * An isolated, owned MongoDB deployment. `client` is connected to the returned
 * `database`; `stop()` removes only this cluster's container and database.
 */
export interface MongoTestCluster {
  readonly containerName: string;
  readonly image: string;
  /** Immutable image ID (`sha256:...`) recorded in test evidence. */
  readonly imageId: string;
  readonly serverVersion: string;
  readonly replicaSetName: string | null;
  readonly host: string;
  readonly port: number;
  /** Connection string for the owned deployment, without a database path. */
  readonly uri: string;
  readonly database: string;
  readonly client: MongoClient;
  /** Connection string for any database on the owned deployment. */
  databaseUri(database?: string): string;
  /** Drops the owned database, then removes the owned container. */
  stop(): Promise<void>;
  /** Removes the owned container without touching data, simulating a crash. */
  kill(): Promise<void>;
}

/** Starts an owned single-member `mongo:8.0.30` replica set on a dynamic loopback port. */
export function startMongoReplicaSet(options: StartMongoOptions = {}): Promise<MongoTestCluster> {
  return startCluster({ ...options, replicaSetName: MONGO_TEST_REPLICA_SET });
}

/**
 * Starts an owned standalone `mongod`. Used to prove that the application
 * refuses deployments without replica-set capability.
 */
export function startMongoStandalone(options: StartMongoOptions = {}): Promise<MongoTestCluster> {
  return startCluster({ ...options, replicaSetName: null });
}

async function startCluster(config: {
  replicaSetName: string | null;
  label?: string;
  image?: string;
  database?: string;
  startTimeoutMs?: number;
}): Promise<MongoTestCluster> {
  assertDockerAvailable();

  const image = config.image ?? MONGO_TEST_IMAGE;
  const label = config.label ?? (config.replicaSetName ? "rs" : "standalone");
  const startTimeoutMs = config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;

  let lastPortCollision: unknown;
  for (let attempt = 1; attempt <= PORT_ATTEMPTS; attempt += 1) {
    const containerName = ownedContainerName(label);
    // mongod listens on the published port number itself, so the replica-set
    // member address is a local address on both sides of the container boundary.
    const port = await freeLoopbackPort();
    const runArgs = ["run", "-d", "--name", containerName, "-p", `${LOOPBACK_HOST}:${port}:${port}`, image];
    if (config.replicaSetName) {
      runArgs.push("--replSet", config.replicaSetName);
    }
    runArgs.push("--port", String(port), "--bind_ip_all");

    try {
      docker(runArgs);
    } catch (error) {
      tryDocker(["rm", "-f", containerName], 60_000);
      const message = error instanceof Error ? error.message : String(error);
      if (!/port is already allocated|address already in use|bind for .* failed/i.test(message)) {
        throw error;
      }
      lastPortCollision = error;
      continue;
    }

    try {
      assertLoopbackPublished(containerName, port);
      return await bootstrapCluster({
        containerName,
        port,
        image,
        replicaSetName: config.replicaSetName,
        database: config.database ?? `alloc_test_${randomSuffix()}`,
        startTimeoutMs,
      });
    } catch (error) {
      tryDocker(["rm", "-f", containerName], 60_000);
      throw error;
    }
  }

  throw new Error(
    `could not publish a loopback port for a ${image} container after ${PORT_ATTEMPTS} attempts: ${
      lastPortCollision instanceof Error ? lastPortCollision.message : String(lastPortCollision)
    }`,
  );
}

/** Instantiates the replica set (if any) and connects the returned client. */
async function bootstrapCluster(cluster: {
  containerName: string;
  port: number;
  image: string;
  replicaSetName: string | null;
  database: string;
  startTimeoutMs: number;
}): Promise<MongoTestCluster> {
  const { containerName, port, image, replicaSetName, database, startTimeoutMs } = cluster;
  const deadline = Date.now() + startTimeoutMs;
  const bootstrap = await waitForMongod(containerName, port, deadline);

  let serverVersion: string;
  try {
    if (replicaSetName) {
      await initiateReplicaSet(bootstrap, replicaSetName, port);
      await waitForPrimary(bootstrap, deadline);
    }
    serverVersion = await readServerVersion(bootstrap);
  } finally {
    await bootstrap.close().catch(() => undefined);
  }

  const { uri, databaseUri } = connectionStrings(port, replicaSetName);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  await client.connect();

  const imageId = docker(["inspect", "--format", "{{.Image}}", containerName]);
  let stopped = false;

  return {
    containerName,
    image,
    imageId,
    serverVersion,
    replicaSetName,
    host: LOOPBACK_HOST,
    port,
    uri,
    database,
    client,
    databaseUri: (name = database) => databaseUri(name),
    async kill() {
      // Removes only this cluster's container; never prunes images or volumes.
      tryDocker(["rm", "-f", containerName], 60_000);
    },
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      await client.db(database).dropDatabase().catch(() => undefined);
      await client.close().catch(() => undefined);
      tryDocker(["rm", "-f", containerName], 60_000);
    },
  };
}

function connectionStrings(port: number, replicaSetName: string | null): {
  uri: string;
  databaseUri: (database: string) => string;
} {
  const query = replicaSetName ? `?replicaSet=${replicaSetName}` : "?directConnection=true";
  const authority = `mongodb://${LOOPBACK_HOST}:${port}`;
  return {
    uri: `${authority}/${query}`,
    databaseUri: (database: string) => `${authority}/${database}${query}`,
  };
}

function ownedContainerName(label: string): string {
  const workspace = (process.env["CONDUCTOR_WORKSPACE_NAME"] ?? "local").replace(/[^a-zA-Z0-9_.-]/g, "");
  return `alloc-test-${label}-${workspace}-${randomSuffix()}`;
}

function randomSuffix(): string {
  return randomBytes(4).toString("hex");
}

/** Reserves a free loopback port; the caller publishes it immediately after. */
async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (port < 1_024) {
    throw new Error(`allocated an unusable port (${port}) for the test MongoDB container`);
  }
  return port;
}

/** Fails loudly when a container is reachable from anywhere but loopback. */
function assertLoopbackPublished(containerName: string, port: number): void {
  const mapping = docker(["port", containerName, `${port}/tcp`]);
  if (mapping !== `${LOOPBACK_HOST}:${port}`) {
    throw new Error(`expected ${containerName} to publish only ${LOOPBACK_HOST}:${port}, found "${mapping}"`);
  }
}

async function waitForMongod(containerName: string, port: number, deadline: number): Promise<MongoClient> {
  let lastError = "no attempt made";
  for (;;) {
    const client = new MongoClient(`mongodb://${LOOPBACK_HOST}:${port}/?directConnection=true`, {
      serverSelectionTimeoutMS: 1_000,
      connectTimeoutMS: 1_000,
    });
    try {
      await client.db("admin").command({ ping: 1 });
      return client;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await client.close().catch(() => undefined);
    }
    if (Date.now() >= deadline) {
      const logs = tryDocker(["logs", "--tail", "20", containerName], 30_000) ?? "(container logs unavailable)";
      throw new Error(
        `mongod in ${containerName} did not accept connections within the start timeout: ${lastError}\n${logs}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function initiateReplicaSet(bootstrap: MongoClient, replicaSetName: string, port: number): Promise<void> {
  const admin = bootstrap.db("admin");
  const hello = await admin.command({ hello: 1 });
  const existingSetName = typeof hello["setName"] === "string" ? (hello["setName"] as string) : null;

  if (existingSetName) {
    if (existingSetName !== replicaSetName) {
      throw new Error(`expected replica set "${replicaSetName}" but connected to "${existingSetName}"`);
    }
    return;
  }

  try {
    await admin.command({
      replSetInitiate: {
        _id: replicaSetName,
        members: [{ _id: 0, host: `${LOOPBACK_HOST}:${port}` }],
      },
    });
  } catch (error) {
    if (!isAlreadyInitialized(error)) {
      throw error;
    }
  }
}

async function waitForPrimary(bootstrap: MongoClient, deadline: number): Promise<void> {
  const admin = bootstrap.db("admin");
  for (;;) {
    const hello = await admin.command({ hello: 1 });
    if (hello["isWritablePrimary"] === true) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("replica set did not elect a primary within the start timeout");
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function readServerVersion(bootstrap: MongoClient): Promise<string> {
  const buildInfo = await bootstrap.db("admin").command({ buildInfo: 1 });
  const version = buildInfo["version"];
  return typeof version === "string" ? version : "unknown";
}

function isAlreadyInitialized(error: unknown): boolean {
  const codeName = (error as { codeName?: unknown } | null)?.codeName;
  return codeName === "AlreadyInitialized";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
