import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createScenarioClock } from "./clock.js";
import { COMPANY_KEYS, fixturePath } from "./generate.js";
import { validateCompany } from "./validate.js";

// Fixture oracle only. The importer owns real source persistence, authority, and financial effects.
export function replaySources(deliveries) {
  const seen = new Map();
  const objects = new Map();
  return deliveries.map(delivery => {
    const key = JSON.stringify([delivery.organizationId, delivery.sourceInstanceId]);
    const transportKey = `${key}:${delivery.deliveryId}`;
    const objectKey = `${key}:${delivery.sourceObjectId}`;
    const payload = [delivery.sourceObjectId, delivery.sourceRevision, delivery.eventType, delivery.occurredAt, delivery.payload];
    if (seen.has(transportKey)) {
      assert.deepEqual(seen.get(transportKey), payload, "delivery identity conflict");
      return "duplicate";
    }
    const revision = Number(delivery.sourceRevision);
    assert(Number.isSafeInteger(revision) && revision > 0, "fixture revision must be a positive integer");
    const current = objects.get(objectKey);
    if (current && revision === current.revision) assert.deepEqual(current.payload, payload, "source revision conflict");
    seen.set(transportKey, payload);
    if (current && revision < current.revision) return "stale";
    if (current && revision === current.revision) return "duplicate";
    objects.set(objectKey, { revision, payload });
    return "accepted";
  });
}

export function replayCompany(candidate) {
  const fixture = validateCompany(candidate);
  const { scenario, expectations } = fixture;
  const clock = createScenarioClock(fixture.manifest.historyStart);
  const history = [...fixture.deliveries].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.deliveryId.localeCompare(b.deliveryId, "en"));
  for (const delivery of history) clock.advanceTo(delivery.observedAt);
  clock.advanceTo(fixture.manifest.referenceDate);
  let spend = expectations.baselineSpendMinor;
  const timeline = [
    [scenario.initialDecisions[0].decidedAt, "request", scenario.commitmentSnapshots[0]],
    [scenario.initialDecisions[1].decidedAt, "amendment", scenario.commitmentSnapshots[1]],
    [scenario.reviewDecision.decidedAt, "review_required", scenario.commitmentSnapshots[1]],
    [scenario.approvedDecision.decidedAt, "human_approval", scenario.commitmentSnapshots[2]],
    [scenario.posting.occurredAt, "matched_posting", scenario.commitment],
  ];
  // Consume contract snapshots; do not implement a second policy evaluator here.
  const trace = timeline.map(([at, step, commitment], index) => {
    clock.advanceTo(at);
    if (step === "matched_posting") spend += scenario.posting.amount.amountMinor;
    const outstanding = commitment.outstandingAmount.amountMinor;
    assert.equal(outstanding, expectations.outstandingMinor[index]);
    return { at: clock.now(), step, recognizedSpendMinor: spend, outstandingMinor: outstanding, exposureMinor: spend + outstanding };
  });
  assert.equal(trace[3].exposureMinor, trace[4].exposureMinor, "posting doubled exposure");
  fixture.runtimeDeliveries.forEach((delivery, index) => {
    clock.advanceTo(fixture.runtimeSchedule[index]);
    assert(Date.parse(delivery.observedAt) <= Date.parse(clock.now()), "delivery scheduled before observation");
  });
  const allSourceOutcomes = replaySources([...history, ...fixture.runtimeDeliveries]);
  assert(allSourceOutcomes.slice(0, history.length).every(outcome => outcome === "accepted"), "history contains duplicate or stale deliveries");
  const sourceOutcomes = allSourceOutcomes.slice(history.length);
  assert.deepEqual(sourceOutcomes, expectations.sourceReplayOutcomes);
  assert.equal(spend, expectations.finalSpendMinor);
  return { scenarioId: scenario.scenarioId, seed: scenario.seed, label: "synthetic fixture replay", trace, sourceOutcomes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const key of COMPANY_KEYS) console.log(JSON.stringify(replayCompany(JSON.parse(readFileSync(fixturePath(key), "utf8"))), null, 2));
}
