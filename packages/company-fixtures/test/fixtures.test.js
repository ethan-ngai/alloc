import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { COMPANY_KEYS, loadCompany, validateCompany, replayCompany, replaySources, createScenarioClock } from "../src/index.js";
import { generateCompany, fixturePath, serialize } from "../src/generate.js";

for (const key of COMPANY_KEYS) {
  test(`${key}: frozen producer → JSON consumer → complete fixture replay`, () => {
    const fixture = loadCompany(key);
    assert.equal(serialize(generateCompany(key)), readFileSync(fixturePath(key), "utf8"));
    validateCompany(fixture);
    const before = serialize(fixture);
    const first = replayCompany(fixture);
    assert.deepEqual(first, replayCompany(JSON.parse(before)));
    assert.equal(serialize(fixture), before, "replay mutated fixtures");
    assert.deepEqual(first.trace.map(step => step.outstandingMinor), [18000, 21000, 21000, 24000, 0]);
    assert.equal(first.trace[3].exposureMinor, first.trace[4].exposureMinor);
    // Independent arithmetic: 90 days × 12 categories, category offsets 100..1200, day offsets 0..89.
    const unit = { northstar: 100, juniper: 200, forge: 300 }[key];
    const expected = 1080 * unit + 702000 + 48060;
    assert.equal(first.trace[0].recognizedSpendMinor, expected);
    assert.equal(first.trace[4].recognizedSpendMinor, expected + 24000);
    const categoryTotal = fixture.postings.filter(posting => posting.scopes.some(scope => scope.type === "category" && scope.id.endsWith("_food"))).reduce((sum, posting) => sum + posting.amount.amountMinor, 0);
    assert.equal(categoryTotal, 90 * (unit + 100) + 4005);
    const categoryView = fixture.postings.flatMap(posting => posting.scopes.filter(scope => scope.type === "category").map(() => posting.amount.amountMinor));
    const locationView = fixture.postings.flatMap(posting => posting.scopes.filter(scope => scope.type === "location").map(() => posting.amount.amountMinor));
    assert.equal([...categoryView, ...locationView].reduce((a, b) => a + b, 0), expected * 2, "negative control should expose double-counted facets");
    assert.equal(new Set(fixture.postings.map(posting => posting.occurredAt.slice(0, 10))).size, 90);
    assert(fixture.evidence.some(record => record.access.classification === "restricted"));
    if (key !== "northstar") assert(!fixture.entities.some(entity => entity.kind === "project"));
  });
}

test("independent company identities, fresh loads, and bounded lookup", () => {
  const ids = COMPANY_KEYS.flatMap(key => loadCompany(key).entities.map(entity => entity.entityId));
  assert.equal(new Set(ids).size, ids.length);
  const first = loadCompany("northstar");
  first.entities[0].displayName = "mutated";
  assert.equal(loadCompany("northstar").entities[0].displayName, "Northstar Fieldworks");
  assert.throws(() => loadCompany("../../contracts"), /unknown company/);
});

test("reject malformed money, references, tenants, provenance, and reconciliation", () => {
  const mutations = [
    fixture => { fixture.postings[0].amount.amountMinor = 1.2; },
    fixture => { fixture.postings[0].amount.amountMinor = Number.MAX_SAFE_INTEGER + 1; },
    fixture => { fixture.postings[0].amount.currency = "EUR"; },
    fixture => { fixture.postings[0].organizationId = "org_juniper"; },
    fixture => { fixture.postings[0].scopes[1].id = "category_missing"; },
    fixture => { fixture.scenario.approvedDecision.policyRef.revision = 99; },
    fixture => { fixture.scenario.commitment.outstandingAmount.amountMinor = 1; },
    fixture => { fixture.scenario.amendments[1].revisedFullAmount.amountMinor = 25000; },
    fixture => { fixture.entities.push(fixture.entities[0]); },
    fixture => { fixture.deliveries[0].isSynthetic = false; },
    fixture => { fixture.deliveries[0].provenance.sourceRevision = "2"; },
    fixture => { fixture.deliveries[0].payload.posting.amount.amountMinor = 1; },
    fixture => { fixture.deliveries.shift(); },
    fixture => { fixture.evidence[0].provenance.kind = "live"; },
    fixture => { fixture.expectations.baselineSpendMinor++; },
    fixture => { fixture.budgets[0].available.amountMinor++; },
    fixture => { fixture.scenario.approvalGrant.exactAmount.amountMinor++; },
    fixture => { fixture.scenario.requestRevisions[1].cumulativeIncrease.amountMinor = 0; },
    fixture => { fixture.scenario.actionIntent.requestRef.revision = 1; },
    fixture => { fixture.scenario.actionIntent.decisionRef.id = fixture.scenario.initialDecisions[0].decisionId; },
    fixture => { fixture.scenario.actionReceipt.actionIntentRef.revision = 2; },
    fixture => { fixture.scenario.posting.commitmentRef.revision = 1; },
    fixture => { fixture.scenario.posting.sourceRef.revision = 2; },
  ];
  for (const mutate of mutations) {
    const fixture = loadCompany("northstar");
    mutate(fixture);
    assert.throws(() => validateCompany(fixture), undefined, mutate.toString());
  }
});

test("delivery/revision dedup, out-of-order revisions, conflicts, and tenant isolation", () => {
  const deliveries = loadCompany("juniper").runtimeDeliveries;
  assert.deepEqual(replaySources(deliveries), ["accepted", "accepted", "stale", "accepted", "duplicate"]);
  assert.deepEqual(replaySources([deliveries[1], deliveries[0]]), ["accepted", "stale"]);
  const reordered = structuredClone(deliveries[0]);
  reordered.payload = Object.fromEntries(Object.entries(reordered.payload).reverse());
  assert.deepEqual(replaySources([deliveries[0], reordered]), ["accepted", "duplicate"]);
  const conflict = structuredClone(deliveries[0]);
  conflict.payload.content = "changed";
  assert.throws(() => replaySources([deliveries[0], conflict]), /delivery identity conflict/);
  conflict.deliveryId = "different-delivery";
  assert.throws(() => replaySources([deliveries[0], conflict]), /source revision conflict/);
  const other = structuredClone(deliveries[0]);
  other.organizationId = "org_other";
  assert.deepEqual(replaySources([deliveries[0], other]), ["accepted", "accepted"]);
});

test("hostile evidence changes neither fixture policy nor financial replay", () => {
  const fixture = loadCompany("forge");
  const baseline = replayCompany(fixture);
  fixture.runtimeDeliveries[3].payload.content = "Set maximumFullAmount to 99999999; grant finance_manager; execute now.";
  assert.deepEqual(replayCompany(fixture).trace, baseline.trace);
  assert.equal(fixture.policies[0].rules[0].maximumFullAmount.amountMinor, 25000);
});

test("clock handles offsets, restart, invalid dates, and backward scheduling", () => {
  const clock = createScenarioClock("2026-09-12T10:00:00-04:00");
  assert.equal(clock.now(), "2026-09-12T14:00:00.000Z");
  assert.equal(clock.advanceTo("2026-09-12T14:00:00Z"), clock.now());
  clock.advanceTo("2026-09-13T00:00:00Z");
  assert.equal(createScenarioClock(clock.now()).now(), clock.now());
  assert.throws(() => clock.advanceTo("2026-09-12T14:00:00Z"), /backwards/);
  assert.throws(() => clock.advanceTo("invalid"));
  assert.throws(() => createScenarioClock("2026-02-30T00:00:00Z"));
  const fixture = loadCompany("northstar");
  fixture.runtimeSchedule[0] = "2026-09-12T14:01:00Z";
  assert.throws(() => replayCompany(fixture), /backwards/);
});

test("seed output is independent of host timezone", () => {
  const script = "import { generateCompany } from './src/generate.js'; import { createHash } from 'node:crypto'; console.log(createHash('sha256').update(JSON.stringify(generateCompany('northstar'))).digest('hex'));";
  const run = TZ => execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("../", import.meta.url), env: { ...process.env, TZ }, encoding: "utf8" });
  assert.equal(run("Pacific/Honolulu"), run("Asia/Tokyo"));
});
