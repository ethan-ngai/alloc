import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startMongoReplicaSet, type MongoTestCluster } from "@alloc/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { MongoImportRepository, type IngestResult } from "../../src/imports/repository.js";
import { connectMongoRuntime, type MongoRuntime } from "../../src/mongo/runtime.js";

const fixturePath = fileURLToPath(new URL("../../../../packages/company-fixtures/fixtures/northstar.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { entities: never[]; manifest: { mappings: never[] }; deliveries: Array<Record<string, unknown>> };

describe("financial imports against a real replica set", () => {
  let cluster: MongoTestCluster | undefined;
  let runtime: MongoRuntime | undefined;

  afterEach(async () => {
    await runtime?.close().catch(() => undefined);
    await cluster?.stop();
    runtime = undefined;
    cluster = undefined;
  });

  it("persists one authoritative fixture posting, rejects stale revisions, and replays safely", async () => {
    ({ cluster, runtime } = await open());
    await runtime.imports.seedEntities(fixture.entities);
    await runtime.imports.seedMappings(fixture.manifest.mappings);
    const delivery = fixture.deliveries[0]!;

    const accepted = await runtime.imports.ingest(delivery as never);
    expect(accepted.disposition).toBe("accepted");
    expect((await runtime.imports.listPostings("org_northstar")).map((posting) => posting.postingId)).toEqual([
      (delivery.payload as { posting: { postingId: string } }).posting.postingId,
    ]);

    expect(await runtime.imports.ingest(delivery as never)).toEqual({ ...accepted, disposition: "duplicate" } satisfies IngestResult);
    const stale = { ...delivery, deliveryId: `${delivery.deliveryId}-late`, observedAt: "2026-12-01T00:00:00.000Z", sourceRevision: "0", provenance: { ...(delivery.provenance as object), sourceRevision: "0", observedAt: "2026-12-01T00:00:00.000Z" } };
    expect((await runtime.imports.ingest(stale as never)).disposition).toBe("quarantined");
    expect(await runtime.imports.listPostings("org_northstar")).toHaveLength(1);
  });

  it("rolls back a delivery when normalized posting insertion conflicts", async () => {
    ({ cluster, runtime } = await open());
    await runtime.imports.seedEntities(fixture.entities);
    const delivery = fixture.deliveries[0]!;
    await runtime.imports.ingest(delivery as never);
    const conflicting = { ...delivery, deliveryId: `${delivery.deliveryId}-other`, sourceObjectId: `${delivery.sourceObjectId}-other`, provenance: { ...(delivery.provenance as object), sourceObjectId: `${delivery.sourceObjectId}-other` } };
    await expect(runtime.imports.ingest(conflicting as never)).rejects.toMatchObject({ code: 11000 });
    expect(await runtime.db.collection("source_deliveries").countDocuments()).toBe(1);
  });
});

async function open(): Promise<{ cluster: MongoTestCluster; runtime: MongoRuntime }> {
  const cluster = await startMongoReplicaSet({ label: "imports" });
  return { cluster, runtime: await connectMongoRuntime({ uri: cluster.uri, database: cluster.database }) };
}
