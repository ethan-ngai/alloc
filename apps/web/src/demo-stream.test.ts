import { describe, expect, it } from "vitest";
import { advanceSyntheticStream, seedSyntheticHistory } from "./demo-stream";
import { companies, type WorkspaceData } from "./data";

const source: WorkspaceData = {
  request: { revision: 1, purpose: "Synthetic request", state: "approved", fullAmount: { amountMinor: 10_000, currency: "USD" }, cumulativeIncrease: { amountMinor: 0, currency: "USD" }, submittedAt: "2026-09-12T14:00:00Z", sourceRevision: "1" },
  decisionReason: "WITHIN_LIMIT",
  budget: { authorized: { amountMinor: 100_000, currency: "USD" }, recognized: { amountMinor: 20_000, currency: "USD" }, committed: { amountMinor: 10_000, currency: "USD" }, available: { amountMinor: 70_000, currency: "USD" } },
  facts: [], evidence: [], forecast: { revision: 1, total: { amountMinor: 30_000, currency: "USD" }, asOf: "2026-09-12T14:00:00Z", horizonEnd: "2026-09-30T00:00:00Z", components: [{ kind: "actual_spend", amount: { amountMinor: 20_000, currency: "USD" } }], warnings: [] },
  activity: [], asOf: "2026-09-12T14:00:00Z", scenarioId: "test",
};

describe("Faker demo stream", () => {
  it("emits deterministic, synthetic financial telemetry without exceeding the available budget", () => {
    const next = advanceSyntheticStream(source, companies[0], 1);
    expect(next.activity[0]?.summary).toBe(advanceSyntheticStream(source, companies[0], 1).activity[0]?.summary);
    expect(next.activity[0]?.id).toBe("faker_stream_northstar_1001");
    expect(next.facts[0]?.source).toBe("faker_live_stream");
    expect(next.budget.available.amountMinor).toBeGreaterThanOrEqual(0);
    expect(next.forecast.revision).toBe(2);
  });

  it("seeds a varied charge history before the live stream begins", () => {
    const history = seedSyntheticHistory(source, companies[0], 42);
    expect(history.activity).toHaveLength(42);
    expect(history.scenarioId).toBe("faker-stream-northstar");
    expect(history.budget.recognized.amountMinor + history.budget.committed.amountMinor).toBeLessThanOrEqual(history.budget.authorized.amountMinor);
    expect(new Set(history.activity.map((event) => event.type)).size).toBeGreaterThan(1);
    expect(history.activity.some((event) => event.summary.includes("posted"))).toBe(true);
  });

  it("keeps a long-running stream within its simulated cap", () => {
    let state = seedSyntheticHistory(source, companies[0]);
    for (let tick = 1; tick <= 360; tick += 1) state = advanceSyntheticStream(state, companies[0], tick);
    expect(state.budget.recognized.amountMinor + state.budget.committed.amountMinor).toBeLessThanOrEqual(state.budget.authorized.amountMinor);
    expect(state.budget.available.amountMinor).toBeGreaterThanOrEqual(0);
  });
});
