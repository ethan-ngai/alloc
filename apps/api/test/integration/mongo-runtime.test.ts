import { MONGO_TEST_REPLICA_SET, startMongoReplicaSet, startMongoStandalone, type MongoTestCluster } from "@alloc/test-support";
import { probeCollection } from "../support/mongo.js";
import { describe, expect, it } from "vitest";
import {
  MongoOrganizationRepository,
  ORGANIZATIONS_COLLECTION,
  ORGANIZATION_ID_INDEX,
  ORGANIZATION_VALIDATOR,
} from "../../src/mongo/organizations.js";
import { connectMongoRuntime, ReplicaSetRequiredError, type MongoRuntime } from "../../src/mongo/runtime.js";
import { juniperOrganization, northstarOrganization } from "../support/organizations.js";

describe("mongo runtime against a real replica set", () => {
  it("refuses a standalone deployment", async () => {
    const standalone = await startMongoStandalone({ label: "standalone" });
    try {
      expect(standalone.replicaSetName).toBeNull();
      await expect(
        connectMongoRuntime({ uri: standalone.uri, database: standalone.database }),
      ).rejects.toBeInstanceOf(ReplicaSetRequiredError);
    } finally {
      await standalone.stop();
    }
  });

  it("connects, verifies the replica set, installs validators and indexes, and reports ready", async () => {
    await withCluster(async (cluster, runtime) => {
      expect(runtime.topology).toBe(MONGO_TEST_REPLICA_SET);
      expect(runtime.readiness.snapshot()).toEqual({ ready: true });
      expect(cluster.serverVersion).toBe("8.0.30");

      const [collectionInfo] = await cluster.client
        .db(cluster.database)
        .listCollections({ name: ORGANIZATIONS_COLLECTION })
        .toArray();
      expect(collectionInfo?.name).toBe(ORGANIZATIONS_COLLECTION);
      expect(collectionInfo).toMatchObject({
        options: {
          validator: ORGANIZATION_VALIDATOR,
          validationLevel: "strict",
          validationAction: "error",
        },
      });

      const indexes = await runtime.db.collection(ORGANIZATIONS_COLLECTION).indexes();
      expect(indexes).toContainEqual(
        expect.objectContaining({ key: { organizationId: 1 }, name: ORGANIZATION_ID_INDEX, unique: true }),
      );
    });
  });

  it("rejects documents and duplicates that violate the organization contract", async () => {
    await withCluster(async (_cluster, runtime) => {
      const organizations = runtime.db.collection(ORGANIZATIONS_COLLECTION);
      const { provenance: _provenance, ...withoutProvenance } = northstarOrganization;

      await expect(organizations.insertOne({ ...withoutProvenance })).rejects.toMatchObject({ code: 121 });
      await expect(
        organizations.insertOne({ ...northstarOrganization, revision: 0 }),
      ).rejects.toMatchObject({ code: 121 });
      await expect(
        organizations.insertOne({ ...northstarOrganization, unexpectedField: true }),
      ).rejects.toMatchObject({ code: 121 });

      await organizations.insertOne({ ...northstarOrganization });
      await expect(organizations.insertOne({ ...northstarOrganization })).rejects.toMatchObject({ code: 11000 });
      expect(await organizations.countDocuments()).toBe(1);
    });
  });

  it("commits multi-document writes atomically", async () => {
    await withCluster(async (_cluster, runtime) => {
      const probe = probeCollection(runtime.db);

      await runtime.withTransaction(async (session) => {
        await runtime.db.collection(ORGANIZATIONS_COLLECTION).insertOne({ ...juniperOrganization }, { session });
        await probe.insertOne({ _id: "committed", note: juniperOrganization.organizationId }, { session });
      });

      expect(await probe.findOne({ _id: "committed" })).not.toBeNull();
      expect(await new MongoOrganizationRepository(runtime.db).findById(juniperOrganization.organizationId)).toEqual(
        juniperOrganization,
      );
    });
  });

  it("rolls back every write when a transaction aborts", async () => {
    await withCluster(async (_cluster, runtime) => {
      const probe = probeCollection(runtime.db);
      const organizations = runtime.db.collection(ORGANIZATIONS_COLLECTION);

      await expect(
        runtime.withTransaction(async (session) => {
          await organizations.insertOne({ ...juniperOrganization }, { session });
          await probe.insertOne({ _id: "aborted" }, { session });
          throw new Error("simulated failure after both writes");
        }),
      ).rejects.toThrowError("simulated failure after both writes");

      expect(await organizations.countDocuments()).toBe(0);
      expect(await probe.countDocuments()).toBe(0);
    });
  });

  it("returns only contract-valid documents and never leaks another tenant", async () => {
    await withCluster(async (_cluster, runtime) => {
      const organizations = runtime.db.collection(ORGANIZATIONS_COLLECTION);
      const repository = new MongoOrganizationRepository(runtime.db);
      await organizations.insertOne({ ...northstarOrganization });
      await organizations.insertOne({ ...juniperOrganization });

      expect(await repository.findById(northstarOrganization.organizationId)).toEqual(northstarOrganization);
      expect(await repository.findById("org_unknown")).toBeNull();

      // A document stored outside the validator must surface as a failure, not as a partial entity.
      await organizations.insertOne(
        { ...northstarOrganization, organizationId: "org_broken", displayName: "" },
        { bypassDocumentValidation: true },
      );
      await expect(repository.findById("org_broken")).rejects.toThrowError();
      expect(await new MongoOrganizationRepository(runtime.db).findById(northstarOrganization.organizationId)).toEqual(
        northstarOrganization,
      );
    });
  });
});

/** Starts an owned cluster, connects the runtime, and always cleans both up. */
async function withCluster(
  work: (cluster: MongoTestCluster, runtime: MongoRuntime) => Promise<void>,
): Promise<void> {
  const cluster = await startMongoReplicaSet({ label: "runtime" });
  let runtime: MongoRuntime | undefined;
  try {
    runtime = await connectMongoRuntime({ uri: cluster.uri, database: cluster.database });
    await work(cluster, runtime);
  } finally {
    await runtime?.close().catch(() => undefined);
    await cluster.stop();
  }
}
