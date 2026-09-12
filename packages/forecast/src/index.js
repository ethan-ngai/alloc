import { ForecastSnapshotSchema } from "@alloc/contracts";

const DAY = 86_400_000;
const money = amountMinor => ({ amountMinor, currency: "USD" });
const day = value => new Date(value).toISOString().slice(0, 10);
const inRange = (value, start, end) => Date.parse(value) >= Date.parse(start) && Date.parse(value) <= Date.parse(end);
const scopeMatches = (record, scope) => scope.type === "organization" || record.scopes.some(item => item.type === scope.type && item.id === scope.id);
const ref = record => ({ type: record.type ?? (record.postingId ? "posting" : record.commitmentId ? "commitment" : "schedule"), id: record.id ?? record.postingId ?? record.commitmentId ?? record.scheduleId, ...(record.revision && { revision: record.revision }) });

function occurrences(schedule, cutoff, horizonEnd) {
  const step = { weekly: 7, monthly: 30, quarterly: 91, annual: 365 }[schedule.cadence];
  if (!step || schedule.status !== "active") return schedule.cadence === "once" && inRange(schedule.nextDueOn, cutoff, horizonEnd) ? [schedule.nextDueOn] : [];
  const dates = [];
  for (let at = Date.parse(schedule.nextDueOn); at <= Date.parse(horizonEnd); at += step * DAY) {
    const due = new Date(at).toISOString().slice(0, 10);
    if (inRange(due, cutoff, horizonEnd) && (!schedule.endsOn || due <= schedule.endsOn)) dates.push(due);
  }
  return dates;
}

// Inputs are normalized, canonical records: a posting appears once even when it has many scopes.
export function calculateForecast(input) {
  const { organizationId, scope, periodStart, asOfCutoff, horizonEnd, postings, commitments = [], schedules = [], assumptions = [], sourceWatermarks = {}, completedAt = asOfCutoff, calculationVersion = "7a-v1" } = input;
  if (!organizationId || !scope || !periodStart || Date.parse(periodStart) > Date.parse(asOfCutoff) || Date.parse(asOfCutoff) > Date.parse(horizonEnd)) throw new Error("invalid forecast period");
  for (const record of [...postings, ...commitments, ...schedules]) if (record.amount.currency !== "USD") throw new Error("USD only");
  const selectedPostings = postings.filter(posting => posting.organizationId === organizationId && scopeMatches(posting, scope));
  const actual = selectedPostings.filter(posting => inRange(posting.occurredAt, periodStart, asOfCutoff));
  const outstanding = commitments.filter(item => item.organizationId === organizationId && scopeMatches(item, scope) && item.amount.amountMinor > 0 && inRange(item.expectedAt, asOfCutoff, horizonEnd));
  const committedPeriods = new Set(outstanding.filter(item => item.obligationId).map(item => `${item.obligationId}:${day(item.expectedAt).slice(0, 7)}`));
  const recurring = schedules.filter(schedule => schedule.organizationId === organizationId && scopeMatches({ scopes: schedule.scopeRefs }, scope)).flatMap(schedule => occurrences(schedule, asOfCutoff, horizonEnd)
    .filter(due => !committedPeriods.has(`${schedule.obligationId}:${due.slice(0, 7)}`)).map(due => ({ schedule, due })));
  const historical = selectedPostings.filter(posting => inRange(posting.occurredAt, periodStart, asOfCutoff) && !schedules.some(schedule => schedule.obligationId === posting.obligationId));
  const historyDays = Math.max(1, Math.round((Date.parse(asOfCutoff) - Date.parse(periodStart)) / DAY) + 1);
  const remainingDays = Math.max(0, Math.round((Date.parse(horizonEnd) - Date.parse(asOfCutoff)) / DAY));
  const actualAmount = actual.reduce((sum, item) => sum + item.amount.amountMinor, 0);
  const outstandingAmount = outstanding.reduce((sum, item) => sum + item.amount.amountMinor, 0);
  const recurringAmount = recurring.reduce((sum, item) => sum + item.schedule.amount.amountMinor, 0);
  const baselineAmount = Math.round(historical.reduce((sum, item) => sum + item.amount.amountMinor, 0) * remainingDays / historyDays);
  const components = [
    { kind: "actual_spend", amount: money(actualAmount), inputRefs: actual.map(ref) },
    { kind: "outstanding_commitment", amount: money(outstandingAmount), inputRefs: outstanding.map(ref) },
    { kind: "uncommitted_baseline", amount: money(baselineAmount + recurringAmount), inputRefs: [...historical, ...recurring.map(item => ({ type: "schedule", id: item.schedule.scheduleId, revision: item.schedule.revision }))].map(ref) },
  ];
  for (const assumption of assumptions) {
    if (!scopeMatches({ scopes: [assumption.scope] }, scope) || !inRange(assumption.effectiveFrom, periodStart, horizonEnd)) continue;
    const amount = assumption.kind === "fixed_adjustment" ? assumption.amount.amountMinor
      : assumption.kind === "percentage_change" ? Math.round(baselineAmount * assumption.valueBasisPoints / 10_000)
      : 0;
    if (amount) components.push({ kind: "scenario_adjustment", amount: money(amount), inputRefs: assumption.evidenceRefs });
  }
  const total = components.reduce((sum, component) => sum + component.amount.amountMinor, 0);
  if (total < 0) throw new Error("scenario cannot produce a negative forecast");
  const snapshot = {
    schemaVersion: "1.0.0", organizationId, forecastId: input.forecastId, revision: input.revision ?? 1,
    kind: assumptions.length ? "scenario" : "baseline", scope, asOfCutoff, horizonEnd, calculationVersion,
    inputVersions: [...selectedPostings, ...outstanding, ...schedules].map(ref), sourceWatermarks, assumptions, components,
    total: money(total), sensitivity: { low: money(Math.max(0, total - Math.round(baselineAmount * 0.1))), base: money(total), high: money(total + Math.round(baselineAmount * 0.1)), calibratedProbability: false },
    coverageWarnings: input.coverageWarnings ?? [], completedAt,
  };
  return ForecastSnapshotSchema.parse(snapshot);
}
