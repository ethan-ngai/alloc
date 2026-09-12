import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calculateForecast } from "../src/index.js";

const usd = amountMinor => ({ amountMinor, currency: "USD" });
const scope = { type: "organization", id: "org_northstar" };
const input = (overrides = {}) => ({ organizationId: "org_northstar", forecastId: "forecast_northstar_q3", scope, periodStart: "2026-09-01T00:00:00Z", asOfCutoff: "2026-09-10T00:00:00Z", horizonEnd: "2026-09-30T00:00:00Z", postings: [], ...overrides });

test("baseline counts canonical spend once and suppresses a committed recurring obligation", () => {
  const forecast = calculateForecast(input({
    postings: [1, 2, 3].map((id, index) => ({ type: "posting", id: `posting_test_${id}`, revision: 1, organizationId: "org_northstar", occurredAt: `2026-09-0${id}T00:00:00Z`, amount: usd(100), scopes: [scope] })),
    commitments: [{ type: "commitment", id: "commitment_test", revision: 1, organizationId: "org_northstar", expectedAt: "2026-09-14T00:00:00Z", obligationId: "contract_hosting", amount: usd(500), scopes: [scope] }],
    schedules: [{ scheduleId: "schedule_hosting", revision: 1, organizationId: "org_northstar", obligationId: "contract_hosting", cadence: "monthly", nextDueOn: "2026-09-14", endsOn: null, status: "active", amount: usd(500), scopeRefs: [scope] }],
  }));
  assert.equal(forecast.total.amountMinor, 1400); // 300 actual + 500 commitment + 600 (300/10 days × 20 days)
  assert.equal(forecast.components[2].amount.amountMinor, 600);
});

test("scenario, late data, and non-USD boundaries are deterministic", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../company-fixtures/fixtures/northstar.json", import.meta.url)));
  const base = input({ forecastId: "forecast_fixture_q3", periodStart: "2026-09-01T00:00:00Z", asOfCutoff: "2026-09-11T23:59:59Z", horizonEnd: "2026-09-30T00:00:00Z", postings: fixture.postings });
  const baseline = calculateForecast(base);
  const scenario = calculateForecast({ ...base, forecastId: "forecast_fixture_reduced", assumptions: [{ kind: "percentage_change", assumptionId: "assumption_reduce", name: "Reduce variable spend", scope, effectiveFrom: "2026-09-12T00:00:00Z", effectiveTo: "2026-09-30T00:00:00Z", evidenceRefs: [], valueBasisPoints: -2000 }] });
  assert.equal(scenario.total.amountMinor, baseline.total.amountMinor - Math.round(baseline.components[2].amount.amountMinor * .2));
  assert.equal(calculateForecast({ ...base, postings: [...fixture.postings, { ...fixture.postings[0], postingId: "posting_late", occurredAt: "2026-10-01T00:00:00Z" }] }).total.amountMinor, baseline.total.amountMinor);
  const late = calculateForecast({ ...base, postings: [...fixture.postings, { ...fixture.postings[0], postingId: "posting_late_history", occurredAt: "2026-09-05T00:00:00Z", amount: usd(1000) }] });
  assert(late.total.amountMinor > baseline.total.amountMinor, "a late historical posting revises the baseline");
  assert.throws(() => calculateForecast(input({ postings: [{ type: "posting", id: "posting_eur", revision: 1, organizationId: "org_northstar", occurredAt: "2026-09-01T00:00:00Z", amount: { amountMinor: 1, currency: "EUR" }, scopes: [scope] }] })), /USD only/);
});

test("timing shifts move a commitment across the horizon", () => {
  const commitment = { type: "commitment", id: "commitment_shift", revision: 1, organizationId: "org_northstar", expectedAt: "2026-09-20T00:00:00Z", amount: usd(500), scopes: [scope] };
  const baseline = calculateForecast(input({ commitments: [commitment] }));
  const shifted = calculateForecast(input({ forecastId: "forecast_shifted", commitments: [commitment], assumptions: [{ kind: "timing_shift", assumptionId: "assumption_shift", name: "Defer commitment", scope, effectiveFrom: "2026-09-10T00:00:00Z", effectiveTo: "2026-10-31T00:00:00Z", evidenceRefs: [], targetRef: { type: "commitment", id: "commitment_shift", revision: 1 }, shiftDays: 20 }] }));
  assert.equal(baseline.total.amountMinor, 500);
  assert.equal(shifted.total.amountMinor, 0);
});
