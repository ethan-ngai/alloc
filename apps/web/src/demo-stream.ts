import { faker } from "@faker-js/faker/locale/en_US";
import type { CompanyConfig, WorkspaceData } from "./data";

const seedFor = (company: CompanyConfig, tick: number) => [...company.key].reduce((total, letter) => total + letter.charCodeAt(0), 0) + tick;

const baselineCaps: Record<CompanyConfig["key"], number> = {
  northstar: 4_800_000,
  juniper: 6_500_000,
  forge: 8_200_000,
};

function financeBaseline(source: WorkspaceData, company: CompanyConfig): WorkspaceData {
  const authorized = baselineCaps[company.key];
  const recognized = Math.round(authorized * (company.key === "juniper" ? 0.61 : 0.56));
  const committed = Math.round(authorized * (company.key === "forge" ? 0.17 : 0.12));
  const currency = source.budget.authorized.currency;
  return {
    ...source,
    budget: {
      authorized: { amountMinor: authorized, currency },
      recognized: { amountMinor: recognized, currency },
      committed: { amountMinor: committed, currency },
      available: { amountMinor: authorized - recognized - committed, currency },
    },
    forecast: {
      ...source.forecast,
      total: { amountMinor: Math.round(authorized * 0.86), currency },
      components: source.forecast.components.map((component, index) => index === 0
        ? { ...component, amount: { amountMinor: recognized, currency } }
        : { ...component, amount: { amountMinor: committed, currency } }),
    },
  };
}

function eventFor(company: CompanyConfig, tick: number, occurredAt: string, currency: string) {
  faker.seed(seedFor(company, tick));
  const range = company.key === "juniper" ? { min: 1_200, max: 38_000 } : company.key === "forge" ? { min: 18_000, max: 185_000 } : { min: 8_000, max: 96_000 };
  const amountMinor = faker.number.int(range);
  const category = faker.helpers.arrayElement(company.categories);
  const vendor = faker.company.name();
  const mode = faker.helpers.weightedArrayElement([{ weight: 68, value: "posting" }, { weight: 22, value: "request" }, { weight: 10, value: "decision" }]);
  const type = mode === "posting" ? "posting" : mode === "request" ? "request" : "decision";
  const summary = mode === "posting"
    ? `Posting stream_${tick} posted ${amountMinor} ${currency} · ${category} · ${vendor}`
    : mode === "request"
      ? `Request stream_${tick} revision ${tick} review_required · ${category} · ${vendor}`
      : `Decision stream_${tick} context_checked for stream_${tick} revision ${tick} · ${category}`;
  return { id: `faker_stream_${company.key}_${tick}`, type, occurredAt, summary, amountMinor, mode };
}

export function seedSyntheticHistory(source: WorkspaceData, company: CompanyConfig, count = 42): WorkspaceData {
  const baseline = financeBaseline(source, company);
  const now = Date.now();
  const history = Array.from({ length: count }, (_, index) => eventFor(
    company,
    index + 1,
    new Date(now - (count - index) * (90 * 24 * 60 * 60_000 / count)).toISOString(),
    baseline.budget.authorized.currency,
  )).reverse();
  return { ...baseline, scenarioId: `faker-stream-${company.key}`, activity: [...history, ...baseline.activity] };
}

/**
 * Browser-only synthetic telemetry for the demo. It is intentionally separate
 * from the contract mock: these observations never create an authorization,
 * mutate its API state, or claim to be financial source-of-record data.
 */
export function advanceSyntheticStream(current: WorkspaceData, company: CompanyConfig, tick: number): WorkspaceData {
  const now = new Date().toISOString();
  const event = eventFor(company, tick + 1_000, now, current.budget.authorized.currency);
  const amountMinor = event.amountMinor;
  const currency = current.budget.authorized.currency;
  let recognized = current.budget.recognized.amountMinor;
  let committed = current.budget.committed.amountMinor;
  let forecast = current.forecast.total.amountMinor;

  const eligibleForPosting = event.mode === "posting" && tick % 4 === 0;
  const eligibleForCommitment = event.mode === "request" && tick % 10 === 0;
  if (eligibleForPosting) {
    const refund = tick % 9 === 0;
    const cappedAmount = Math.min(amountMinor, Math.round(current.budget.available.amountMinor * 0.08));
    recognized = Math.max(0, recognized + (refund ? -cappedAmount : cappedAmount));
    forecast = Math.max(0, forecast + (refund ? -cappedAmount : cappedAmount));
  } else if (eligibleForCommitment) {
    const cappedAmount = Math.min(amountMinor, Math.round(current.budget.available.amountMinor * 0.12));
    committed += cappedAmount;
    forecast += cappedAmount;
  }

  const available = Math.max(0, current.budget.authorized.amountMinor - recognized - committed);
  return {
    ...current,
    budget: {
      ...current.budget,
      recognized: { amountMinor: recognized, currency },
      committed: { amountMinor: committed, currency },
      available: { amountMinor: available, currency },
    },
    forecast: {
      ...current.forecast,
      total: { amountMinor: forecast, currency },
      revision: current.forecast.revision + 1,
      asOf: now,
      components: current.forecast.components.map((component, index) => index === 0
        ? { ...component, amount: { amountMinor: recognized, currency } }
        : component),
    },
    activity: [event, ...current.activity].slice(0, 120),
    facts: [{ label: `Stream · ${event.summary.split(" · ")[1] ?? "Operational"}`, value: "Observed", source: "faker_live_stream", trust: "synthetic" }, ...current.facts].slice(0, 25),
    asOf: now,
    scenarioId: `faker-stream-${company.key}-v1`,
  };
}
