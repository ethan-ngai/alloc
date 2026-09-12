import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startMongoReplicaSet, type MongoTestCluster } from "@alloc/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { connectMongoRuntime, type MongoRuntime } from "../../src/mongo/runtime.js";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../packages/company-fixtures/fixtures/northstar.json", import.meta.url)), "utf8")) as { entities: never[]; deliveries: Array<Record<string, unknown>> };
const principal = { principalId: "user_jd", organizationId: "org_northstar", roles: ["approver"] };

describe("financial context against a real replica set", () => {
  let cluster: MongoTestCluster | undefined;
  let runtime: MongoRuntime | undefined;

  afterEach(async () => { await runtime?.close().catch(() => undefined); await cluster?.stop(); });

  it("retrieves current food, software, and site postings without a project scope", async () => {
    ({ cluster, runtime } = await open());
    await runtime.imports.seedEntities(fixture.entities);
    for (const delivery of fixture.deliveries.filter((value) => value.eventType === "fixture.expense")) await runtime.imports.ingest(delivery as never);

    for (const scope of [
      { type: "category", id: "category_food" },
      { type: "category", id: "category_software" },
      { type: "location", id: "location_0" },
    ] as const) {
      const response = await runtime.context.query("org_northstar", principal, { query: scope.id.split("_").at(-1)!, scopes: [scope], asOf: "2026-09-12T23:59:59.000Z", limit: 100 });
      expect(response.facts.some((fact) => fact.ref.type === "posting")).toBe(true);
      expect(response.facts.every((fact) => fact.scopeRefs.some((item) => item.type === scope.type && item.id === scope.id))).toBe(true);
      expect(response.evidence).not.toHaveLength(0);
    }
    expect(await runtime.db.collection("normalized_postings").indexes()).toContainEqual(expect.objectContaining({ name: "financial_context_scope" }));
  });
});

async function open(): Promise<{ cluster: MongoTestCluster; runtime: MongoRuntime }> {
  const cluster = await startMongoReplicaSet({ label: "context" });
  return { cluster, runtime: await connectMongoRuntime({ uri: cluster.uri, database: cluster.database }) };
}
