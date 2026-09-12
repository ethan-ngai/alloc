#!/usr/bin/env node
/**
 * Local development orchestration.
 *
 * Starts a workspace-scoped single-member MongoDB replica set, builds the
 * workspaces, then runs the API with TypeScript watchers. Container names and
 * ports derive from the Conductor workspace, so `run_mode = "concurrent"` is
 * safe across workspaces.
 *
 * No secret file is required or copied: the development JWT secret is a
 * well-known local value that must never be used outside this script.
 */
import { spawn, spawnSync } from "node:child_process";
import { SignJWT } from "jose";
import { MongoClient } from "mongodb";

const DEV_JWT_SECRET = "alloc-local-development-jwt-secret-not-for-production";
const DEV_JWT_ISSUER = "alloc-local";
const DEV_JWT_AUDIENCE = "alloc-api";
const DEV_ORGANIZATION_ID = "org_northstar";
const MONGO_IMAGE = "mongo:8.0.30";
const REPLICA_SET = "allocdev";
const START_TIMEOUT_MS = 90_000;

const workspace = (process.env.CONDUCTOR_WORKSPACE_NAME ?? "local").replace(/[^a-zA-Z0-9_.-]/g, "") || "local";
const apiPort = Number(process.env.CONDUCTOR_PORT ?? process.env.PORT ?? 3000);
const mongoPort = apiPort + 1;
const containerName = `alloc-dev-${workspace}-mongo`;
const database = `alloc_dev_${workspace.replace(/[^a-zA-Z0-9_]/g, "_")}`;
const mongoUri = `mongodb://127.0.0.1:${mongoPort}/?replicaSet=${REPLICA_SET}`;

const children = [];
let stopping = false;

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  await ensureMongo();
  run("npm", ["run", "build"]);
  watch("tsc --watch", ["run", "build", "--workspace", "@alloc/contracts", "--", "--watch"]);
  watch("tsc --watch", ["run", "build", "--workspace", "@alloc/api", "--", "--watch"]);
  watch("api", ["exec", "--", "node", "--watch", "apps/api/dist/server.js"], apiEnvironment());
  watch("executor", ["exec", "--", "node", "--watch", "apps/api/dist/execution/worker.js"], apiEnvironment());
  await waitForApiReady();
  await printEndpoints();
  console.log("[dev] watching for changes; press Ctrl+C to stop and remove the container");
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
}

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function dockerOrThrow(args) {
  const output = docker(args);
  if (output === null) {
    throw new Error(`docker ${args.join(" ")} failed; is Docker running?`);
  }
  return output;
}

async function ensureMongo() {
  // Recreate so the container's port mapping always matches this workspace.
  docker(["rm", "-f", containerName]);
  // The published port is also mongod's own port: the replica-set member
  // address must resolve to this node from both sides of the boundary.
  dockerOrThrow([
    "run", "-d", "--name", containerName,
    "-p", `127.0.0.1:${mongoPort}:${mongoPort}`,
    MONGO_IMAGE, "--replSet", REPLICA_SET, "--port", String(mongoPort), "--bind_ip_all",
  ]);

  const bootstrap = await waitForMongod();
  try {
    const hello = await bootstrap.db("admin").command({ hello: 1 });
    if (typeof hello.setName !== "string") {
      await bootstrap.db("admin").command({
        replSetInitiate: { _id: REPLICA_SET, members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }] },
      });
    }
    await waitForPrimary(bootstrap);
  } finally {
    await bootstrap.close();
  }
  console.log(`[dev] mongodb ${MONGO_IMAGE} ready on 127.0.0.1:${mongoPort} (container ${containerName}, database ${database})`);
}

async function waitForMongod() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const client = new MongoClient(`mongodb://127.0.0.1:${mongoPort}/?directConnection=true`, {
      serverSelectionTimeoutMS: 1_000,
    });
    try {
      await client.db("admin").command({ ping: 1 });
      return client;
    } catch {
      await client.close().catch(() => undefined);
    }
    if (Date.now() >= deadline) {
      throw new Error(`mongod did not start within ${START_TIMEOUT_MS}ms; check: docker logs ${containerName}`);
    }
    await sleep(250);
  }
}

async function waitForPrimary(client) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const hello = await client.db("admin").command({ hello: 1 });
    if (hello.isWritablePrimary === true) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("the development replica set did not elect a primary");
    }
    await sleep(250);
  }
}

function apiEnvironment() {
  // Inherit PATH and the rest of the environment; the API only needs overrides.
  return {
    ...process.env,
    CONDUCTOR_PORT: String(apiPort),
    HOST: "127.0.0.1",
    PORT: String(apiPort),
    LOG_LEVEL: "info",
    MONGO_URI: mongoUri,
    MONGO_DATABASE: database,
    JWT_SECRET: DEV_JWT_SECRET,
    JWT_ISSUER: DEV_JWT_ISSUER,
    JWT_AUDIENCE: DEV_JWT_AUDIENCE,
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function watch(label, args, env = process.env) {
  const child = spawn("npm", args, { stdio: "inherit", env });
  child.on("error", (error) => {
    console.error(`[dev] ${label} failed to start: ${error.message}`);
    shutdown(1);
  });
  child.on("exit", (code) => shutdown(code ?? 0));
  children.push(child);
}

async function printEndpoints() {
  const token = await new SignJWT({ sub: "principal_dev", org: DEV_ORGANIZATION_ID, roles: ["approver"] })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(DEV_JWT_ISSUER)
    .setAudience(DEV_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(new TextEncoder().encode(DEV_JWT_SECRET));

  console.log(`[dev] api        http://127.0.0.1:${apiPort}`);
  console.log(`[dev] liveness   curl -s http://127.0.0.1:${apiPort}/health/live`);
  console.log(`[dev] readiness  curl -s http://127.0.0.1:${apiPort}/health/ready`);
  console.log(`[dev] dev token  ${token}`);
  console.log(
    `[dev] try        curl -s -H "Authorization: Bearer ${token}" http://127.0.0.1:${apiPort}/v1/organizations/${DEV_ORGANIZATION_ID}`,
  );
  console.log(
    `[dev] note       no organization record is seeded yet, so that call returns 404 until a company entity is stored in ${database}`,
  );
  console.log("[dev] the development token is signed with a public secret and is not valid outside local development");
}

/**
 * Waits for the API to answer liveness. The TypeScript watchers emit once more
 * after the process starts, which restarts the API, so consecutive probes prove
 * the listener has settled before the endpoints are printed.
 */
async function waitForApiReady() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let consecutive = 0;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/health/live`, { signal: AbortSignal.timeout(2_000) });
      consecutive = response.ok ? consecutive + 1 : 0;
    } catch {
      consecutive = 0;
    }
    if (consecutive >= 3) {
      return;
    }
    if (Date.now() >= deadline) {
      console.warn("[dev] the api has not answered liveness consistently yet; the watchers are still running");
      return;
    }
    await sleep(1_000);
  }
}

function shutdown(code) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  docker(["rm", "-f", containerName]);
  process.exit(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
