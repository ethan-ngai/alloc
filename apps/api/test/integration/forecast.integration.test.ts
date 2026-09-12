import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startMongoReplicaSet, type MongoTestCluster } from "@alloc/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { contributionDeltas } from "../../src/forecasts/repository.js";
import { connectMongoRuntime, type MongoRuntime } from "../../src/mongo/runtime.js";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../packages/company-fixtures/fixtures/northstar.json", import.meta.url)), "utf8")) as { postings: never[]; entities: never[]; manifest: { mappings: never[] }; deliveries: never[] };

describe("forecast snapshots against a real replica set", () => {
  let cluster: MongoTestCluster | undefined;
  let runtime: MongoRuntime | undefined;

  afterEach(async () => {
    await runtime?.close().catch(() => undefined);
    await cluster?.stop();
    runtime = undefined;
    cluster = undefined;
  });

  it("coalesces duplicate inputs, preserves the cutoff, and links an immutable correction", async () => {
    ({ cluster, runtime } = await open());
    const input = {
      organizationId: "org_northstar", forecastId: "forecast_northstar_q3", scope: { type: "organization" as const, id: "org_northstar" },
      periodStart: "2026-06-01T00:00:00.000Z", asOfCutoff: "2026-09-10T00:00:00.000Z", horizonEnd: "2026-09-30T00:00:00.000Z",
      postings: fixture.postings, sourceWatermarks: { alpha: "2026-09-10T00:00:00.000Z", zeta: "2026-09-10T00:00:00.000Z" },
    };
    const first = await runtime.forecasts.refresh(input);
    expect((await runtime.forecasts.refresh(input)).revision).toBe(1);
    expect((await runtime.forecasts.refresh({
      ...input,
      postings: [...input.postings].reverse(),
      sourceWatermarks: { zeta: "2026-09-10T00:00:00.000Z", alpha: "2026-09-10T00:00:00.000Z" },
    })).revision).toBe(1);
    const revised = await runtime.forecasts.refresh({ ...input, asOfCutoff: "2026-09-11T00:00:00.000Z", sourceWatermarks: { fixture: "2026-09-11T00:00:00.000Z" } });

    expect(revised).toMatchObject({ revision: 2, correctsForecastRef: { type: "forecast", id: input.forecastId, revision: 1 } });
    expect(revised.total.amountMinor).toBeGreaterThanOrEqual(first.total.amountMinor);
    expect(await runtime.forecasts.get(input.organizationId, input.forecastId)).toEqual(revised);
    expect(await runtime.forecasts.get(input.organizationId, input.forecastId, 1)).toEqual(first);
    expect(contributionDeltas(revised, first)).toHaveLength(revised.components.length);

    const priorWithTwoAdjustments = {
      ...first,
      components: [...first.components,
        { kind: "scenario_adjustment" as const, amount: { amountMinor: 10, currency: "USD" as const }, inputRefs: [] },
        { kind: "scenario_adjustment" as const, amount: { amountMinor: 15, currency: "USD" as const }, inputRefs: [] },
      ],
    };
    expect(contributionDeltas(first, priorWithTwoAdjustments)).toContainEqual({ kind: "scenario_adjustment", amountMinor: -25 });

    await runtime.imports.seedEntities(fixture.entities);
    await runtime.imports.seedMappings(fixture.manifest.mappings);
    await runtime.imports.ingest(fixture.deliveries[0]!);
    expect(await runtime.db.collection("forecast_refreshes").countDocuments({ organizationId: input.organizationId })).toBeGreaterThan(1);
  });
});

async function open(): Promise<{ cluster: MongoTestCluster; runtime: MongoRuntime }> {
  const cluster = await startMongoReplicaSet({ label: "forecast" });
  return { cluster, runtime: await connectMongoRuntime({ uri: cluster.uri, database: cluster.database }) };
}
