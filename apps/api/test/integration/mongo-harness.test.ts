import { docker, MONGO_TEST_IMAGE, startMongoReplicaSet, tryDocker, type MongoTestCluster } from "@alloc/test-support";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeCollection } from "../support/mongo.js";

describe("owned mongo harness", () => {
  let primary: MongoTestCluster;
  let sibling: MongoTestCluster;

  beforeAll(async () => {
    primary = await startMongoReplicaSet({ label: "primary" });
    sibling = await startMongoReplicaSet({ label: "sibling" });
  }, 240_000);

  afterAll(async () => {
    await primary?.stop();
    await sibling?.stop();
  });

  it("runs the pinned image on a dynamic loopback-only port with a unique container", () => {
    expect(primary.image).toBe(MONGO_TEST_IMAGE);
    expect(primary.imageId).toBe(sibling.imageId);
    expect(primary.imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(primary.containerName).not.toBe(sibling.containerName);
    expect(primary.port).not.toBe(sibling.port);
    expect(primary.port).toBeGreaterThan(1_023);
    expect(docker(["port", primary.containerName, `${primary.port}/tcp`])).toBe(`127.0.0.1:${primary.port}`);
    expect(docker(["port", sibling.containerName, `${sibling.port}/tcp`])).toBe(`127.0.0.1:${sibling.port}`);
  });

  it("allocates a unique database and never shares data between suites", async () => {
    expect(primary.database).not.toBe(sibling.database);

    const first = probeCollection(primary.client.db(`${primary.database}_suite_a`));
    const second = probeCollection(primary.client.db(`${primary.database}_suite_b`));
    await first.insertOne({ _id: "only-in-a" });

    expect(await first.countDocuments()).toBe(1);
    expect(await second.countDocuments()).toBe(0);
    expect(await probeCollection(sibling.client.db(sibling.database)).countDocuments()).toBe(0);
  });

  it("removes only the cluster it owns", async () => {
    await probeCollection(primary.client.db(primary.database)).insertOne({ _id: "owned" });
    await probeCollection(sibling.client.db(sibling.database)).insertOne({ _id: "untouched" });
    const siblingPort = sibling.port;

    await primary.stop();

    expect(tryDocker(["inspect", primary.containerName])).toBeNull();
    expect(tryDocker(["inspect", sibling.containerName])).not.toBeNull();
    expect(await probeCollection(sibling.client.db(sibling.database)).countDocuments()).toBe(1);
    const unreachable = new MongoClient(primary.uri, { serverSelectionTimeoutMS: 1_000 });
    try {
      await expect(unreachable.db("admin").command({ ping: 1 })).rejects.toThrowError();
    } finally {
      await unreachable.close();
    }

    const siblingStillServed = new MongoClient(sibling.databaseUri(), { serverSelectionTimeoutMS: 2_000 });
    try {
      await siblingStillServed.connect();
      expect(await probeCollection(siblingStillServed.db(sibling.database)).countDocuments()).toBe(1);
    } finally {
      await siblingStillServed.close();
    }
    expect(siblingPort).toBe(sibling.port);
  });
});
