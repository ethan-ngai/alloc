import { MongoClient, type ClientSession, type Db } from "mongodb";
import { createReadiness, type Readiness } from "../readiness.js";
import { ensureImportCollections, MongoImportRepository, type ImportRepository } from "../imports/repository.js";
import { ensureContextIndexes, MongoContextRepository, type ContextRepository } from "../context/repository.js";
import { ensureGraphCollections, MongoGraphRepository, type GraphRepository } from "../context/graph.js";
import { ensureForecastCollections, MongoForecastRepository, type ForecastRepository } from "../forecasts/repository.js";
import {
  ensureOrganizationCollection,
  MongoOrganizationRepository,
  type OrganizationRepository,
} from "./organizations.js";

export interface MongoRuntimeOptions {
  readonly uri: string;
  readonly database: string;
  readonly serverSelectionTimeoutMs?: number;
  readonly heartbeatFrequencyMs?: number;
}

/** Raised when the deployment cannot support multi-document transactions. */
export class ReplicaSetRequiredError extends Error {
  override readonly name = "ReplicaSetRequiredError";

  constructor(readonly deploymentKind: string) {
    super(
      `MongoDB deployment is ${deploymentKind}; a replica set is required for multi-document transactions`,
    );
  }
}

export interface MongoRuntime {
  readonly client: MongoClient;
  readonly db: Db;
  readonly readiness: Readiness;
  /** Replica-set name, or `sharded-cluster` for a mongos deployment. */
  readonly topology: string;
  readonly organizations: OrganizationRepository;
  readonly imports: ImportRepository;
  readonly context: ContextRepository;
  readonly graph: GraphRepository;
  readonly forecasts: ForecastRepository;
  withTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Connects, refuses deployments without transaction capability, and installs the
 * organization validators and indexes before the process reports ready.
 */
export async function connectMongoRuntime(options: MongoRuntimeOptions): Promise<MongoRuntime> {
  const client = new MongoClient(options.uri, {
    appName: "alloc-api",
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMs ?? 5_000,
    heartbeatFrequencyMS: options.heartbeatFrequencyMs ?? 10_000,
    retryWrites: true,
    maxPoolSize: 10,
  });
  const readiness = createReadiness();

  try {
    await client.connect();
    const topology = await requireTransactionCapableDeployment(client);
    const db = client.db(options.database);
    await ensureOrganizationCollection(db);
    await ensureImportCollections(db);
    await ensureContextIndexes(db);
    await ensureGraphCollections(db);
    await ensureForecastCollections(db);

    let closed = false;
    client.on("serverHeartbeatFailed", () => {
      if (!closed) {
        readiness.markNotReady("database heartbeat failed");
      }
    });
    client.on("serverHeartbeatSucceeded", () => {
      if (!closed) {
        readiness.markReady();
      }
    });
    readiness.markReady();

    const withTransaction = async <T>(work: (session: ClientSession) => Promise<T>): Promise<T> => {
      const session = client.startSession();
      try {
        let outcome: { value: T } | undefined;
        await session.withTransaction(async () => {
          outcome = { value: await work(session) };
        });
        if (!outcome) throw new Error("transaction completed without running its work");
        return outcome.value;
      } finally {
        await session.endSession();
      }
    };

    const forecasts = new MongoForecastRepository(db, withTransaction);

    return {
      client,
      db,
      readiness,
      topology,
      organizations: new MongoOrganizationRepository(db),
      imports: new MongoImportRepository(db, withTransaction, async (posting, delivery, session) => {
        const scopes = [{ type: "organization", id: posting.organizationId }, ...posting.scopes];
        await Promise.all(scopes.map((scope) => forecasts.schedule({
          organizationId: posting.organizationId, scope,
          sourceWatermark: { sourceInstanceId: delivery.sourceInstanceId, observedAt: delivery.observedAt },
        }, session)));
      }),
      context: new MongoContextRepository(db),
      graph: new MongoGraphRepository(db),
      forecasts,

      /**
       * Runs `work` inside a multi-document transaction. The driver retries on
       * transient transaction errors, so `work` must be idempotent and must use
       * the supplied session for every operation.
       */
      withTransaction,

      async close(): Promise<void> {
        if (closed) {
          return;
        }
        closed = true;
        readiness.markNotReady("shutting down");
        await client.close();
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function requireTransactionCapableDeployment(client: MongoClient): Promise<string> {
  const hello = await client.db("admin").command({ hello: 1 });

  const setName = hello["setName"];
  if (typeof setName === "string" && setName.length > 0) {
    return setName;
  }
  // mongos fronts a sharded cluster, which also supports transactions.
  if (hello["msg"] === "isdbgrid") {
    return "sharded-cluster";
  }
  throw new ReplicaSetRequiredError("standalone");
}
