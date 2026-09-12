import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startMongoReplicaSet, type MongoTestCluster } from "@alloc/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { GraphAccessError } from "../../src/context/graph.js";
import { connectMongoRuntime, type MongoRuntime } from "../../src/mongo/runtime.js";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../packages/company-fixtures/fixtures/northstar.json", import.meta.url)), "utf8")) as { entities: never[]; relationships: Array<Record<string, unknown>> };
const principal = { principalId: "user_jd", organizationId: "org_northstar", roles: ["approver"] };
const input = { subjectId: "employee_maya_chen", relationshipTypes: [], maxHops: 2, maxEntities: 50, asOf: "2026-09-12T14:00:00.000Z" };

describe("verified graph context against a real replica set", () => {
  let cluster: MongoTestCluster | undefined;
  let runtime: MongoRuntime | undefined;
  afterEach(async () => { await runtime?.close().catch(() => undefined); await cluster?.stop(); });

  it("bounds traversal, exposes evidence drill-down, and refreshes an access-safe summary", async () => {
    ({ cluster, runtime } = await open());
    await runtime.imports.seedEntities(fixture.entities);
    const first = fixture.relationships[0]!;
    const second = { ...first, relationshipId: "relationship_department_beacon", revision: 1, fromId: "department_field_engineering", toId: "project_beacon", type: "owned_by", evidenceRefs: [{ type: "evidence", id: "evidence_trip_active", revision: 1 }] };
    await runtime.graph.seedRelationships([first, second] as never);

    const oneHop = await runtime.graph.query("org_northstar", principal, { ...input, maxHops: 1 });
    expect(oneHop.entities.map((entity) => entity.entityId)).toEqual(["employee_maya_chen", "department_field_engineering"]);
    expect(oneHop.relationships).toHaveLength(1);
    expect(oneHop.evidenceRefs).toEqual([{ type: "evidence", id: "evidence_trip_active", revision: 1 }]);

    const twoHops = await runtime.graph.query("org_northstar", principal, input);
    expect(twoHops.entities.map((entity) => entity.entityId)).toContain("project_beacon");
    expect(twoHops.summary).toContain("2 verified relationships");
    const originalWatermark = twoHops.sourceWatermark;

    await runtime.db.collection("import_entities").updateOne({ organizationId: "org_northstar", entityId: "project_beacon" }, { $set: { "access.classification": "restricted", "access.allowedPrincipalIds": ["employee_other"] } });
    const afterAccessChange = await runtime.graph.query("org_northstar", principal, input);
    expect(afterAccessChange.entities.map((entity) => entity.entityId)).not.toContain("project_beacon");
    expect(afterAccessChange.sourceWatermark).not.toBe(originalWatermark);

    await runtime.db.collection("import_entities").updateOne({ organizationId: "org_northstar", entityId: "project_beacon" }, { $set: { "access.classification": "internal", "access.allowedPrincipalIds": [] } });
    await runtime.graph.seedRelationships([{ ...second, revision: 2, evidenceRefs: [{ type: "evidence", id: "evidence_trip_active", revision: 2 }] }] as never);
    const afterEvidenceEdit = await runtime.graph.query("org_northstar", principal, input);
    expect(afterEvidenceEdit.evidenceRefs.map((ref) => ref.revision)).toEqual([1, 2]);
    expect(await runtime.db.collection("scope_summaries").countDocuments()).toBeGreaterThan(1);
  });

  it("does not traverse candidate edges or disclose a restricted endpoint", async () => {
    ({ cluster, runtime } = await open());
    await runtime.imports.seedEntities(fixture.entities);
    const candidate = { ...fixture.relationships[0]!, relationshipId: "relationship_candidate_beacon", toId: "project_beacon", verification: "candidate" };
    await runtime.db.collection("relationships").insertOne(candidate);
    const result = await runtime.graph.query("org_northstar", principal, input);
    expect(result.relationships).toHaveLength(0);
    await runtime.db.collection("import_entities").updateOne({ organizationId: "org_northstar", entityId: "employee_maya_chen" }, { $set: { "access.classification": "restricted", "access.allowedPrincipalIds": [] } });
    await expect(runtime.graph.query("org_northstar", principal, input)).rejects.toBeInstanceOf(GraphAccessError);
  });
});

async function open(): Promise<{ cluster: MongoTestCluster; runtime: MongoRuntime }> {
  const cluster = await startMongoReplicaSet({ label: "graph" });
  return { cluster, runtime: await connectMongoRuntime({ uri: cluster.uri, database: cluster.database }) };
}
