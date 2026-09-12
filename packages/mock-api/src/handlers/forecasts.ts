import { CONTRACT_SCHEMA_VERSION } from "@alloc/contracts";
import type { DurableJobMessage, ForecastSnapshot } from "@alloc/contracts";
import type { RecordRef, ScopeRef } from "../contract-types.js";
import { MockContractError } from "../errors.js";
import { forecastIdForScope } from "../ids.js";
import { usd } from "../money.js";
import { MOCK_CALCULATION_VERSION } from "../packs.js";
import {
  appendActivity, assertRegisteredScopes, commitmentFor, forecastSummary, jobSummary,
  scopesIntersect,
} from "./context.js";
import type { Handler } from "./context.js";

export const runForecast: Handler<"forecasts.run"> = (ctx, payload) => {
  assertRegisteredScopes(ctx, [payload.scope]);
  if (Date.parse(payload.horizonEnd) <= Date.parse(payload.asOfCutoff)) {
    throw new MockContractError("VALIDATION_FAILED", "horizonEnd must be later than asOfCutoff", {
      reasonCode: "horizonEndNotAfterAsOfCutoff",
      asOfCutoff: payload.asOfCutoff,
      horizonEnd: payload.horizonEnd,
    });
  }

  const forecastId = forecastIdForScope(payload.scope);
  const history = ctx.company.forecasts.get(forecastId) ?? [];
  const revision = (history.at(-1)?.revision ?? 0) + 1;

  const cutoffMs = Date.parse(payload.asOfCutoff);
  const postings = ctx.company.postings.filter((posting) => (
    scopesIntersect(posting.scopes, [payload.scope]) && Date.parse(posting.occurredAt) <= cutoffMs
  ));
  const postingRefs: RecordRef[] = postings.map((posting) => ({ type: "posting", id: posting.postingId, revision: posting.revision }));
  const corrections = ctx.company.corrections.filter((correction) => {
    if (Date.parse(correction.occurredAt) > cutoffMs) return false;
    return postings.some((posting) => posting.postingId === correction.originalPostingRef.id);
  });
  const correctionRefs: RecordRef[] = corrections.map((correction) => ({
    type: "posting_correction",
    id: correction.correctionId,
    revision: 1,
  }));
  const actualSpendMinor = postings.reduce((total, posting) => total + posting.amount.amountMinor, 0)
    + corrections.reduce((total, correction) => total + correction.amount.amountMinor, 0);

  const commitmentRefs: RecordRef[] = [];
  let outstandingMinor = 0;
  for (const [requestId, revisions] of ctx.company.requests) {
    const commitment = commitmentFor(ctx, requestId);
    if (!commitment || Date.parse(commitment.createdAt) > cutoffMs) continue;
    const approvedDecisions = ctx.company.decisions.filter((decision) => (
      decision.requestRef.id === requestId
      && decision.outcome === "approved"
      && Date.parse(decision.decidedAt) <= cutoffMs
    ));
    const approvedDecision = approvedDecisions.at(-1);
    if (!approvedDecision) continue;
    const approvedRequest = revisions.find((request) => request.revision === approvedDecision.requestRef.revision);
    if (!approvedRequest || !scopesIntersect(approvedRequest.scopes, [payload.scope])) continue;
    const matchedPostings = postings.filter((posting) => posting.commitmentRef?.id === commitment.commitmentId);
    outstandingMinor += Math.max(
      0,
      approvedRequest.fullAmount.amountMinor - matchedPostings.reduce((total, posting) => total + posting.amount.amountMinor, 0),
    );
    commitmentRefs.push({
      type: "commitment",
      id: commitment.commitmentId,
      revision: Math.max(1, approvedDecisions.length + matchedPostings.length),
    });
  }

  const baselineMinor = 0;
  const coverageWarnings: string[] = [];
  let scenarioDeltaMinor = 0;
  const assumptionInputRefs: RecordRef[] = [];
  for (const assumption of payload.assumptions) {
    assumptionInputRefs.push(...assumption.evidenceRefs.map((ref) => structuredClone(ref)));
    if (assumption.kind === "fixed_adjustment") {
      scenarioDeltaMinor += assumption.amount.amountMinor;
    } else if (assumption.kind === "percentage_change") {
      scenarioDeltaMinor += Math.round(
        (assumption.valueBasisPoints * (actualSpendMinor + outstandingMinor + baselineMinor)) / 10_000,
      );
    } else {
      coverageWarnings.push(`ASSUMPTION_KIND_NOT_SIMULATED:${assumption.kind}`);
    }
  }

  const unclampedTotalMinor = actualSpendMinor + outstandingMinor + baselineMinor + scenarioDeltaMinor;
  const totalMinor = Math.max(0, unclampedTotalMinor);
  const kind = payload.assumptions.length > 0 ? "scenario" : "baseline";
  if (unclampedTotalMinor < 0) coverageWarnings.push("TOTAL_CLAMPED_AT_ZERO");
  if (kind === "scenario") coverageWarnings.push("SENSITIVITY_BAND_IS_PLACEHOLDER");

  const snapshot: ForecastSnapshot = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: ctx.company.organizationId,
    forecastId,
    revision,
    kind,
    scope: structuredClone(payload.scope),
    asOfCutoff: payload.asOfCutoff,
    horizonEnd: payload.horizonEnd,
    calculationVersion: MOCK_CALCULATION_VERSION,
    inputVersions: [...postingRefs, ...correctionRefs, ...commitmentRefs],
    sourceWatermarks: {
      mock_scenario: ctx.company.pack.identity.scenarioId,
      mock_clock: ctx.clock.now(),
      mock_request_count: String([...ctx.company.requests.values()].reduce((total, revisions) => total + revisions.length, 0)),
    },
    assumptions: structuredClone(payload.assumptions),
    components: [
      { kind: "actual_spend", amount: usd(actualSpendMinor), inputRefs: [...postingRefs, ...correctionRefs] },
      { kind: "outstanding_commitment", amount: usd(outstandingMinor), inputRefs: commitmentRefs },
      { kind: "uncommitted_baseline", amount: usd(baselineMinor), inputRefs: [] },
      { kind: "scenario_adjustment", amount: usd(scenarioDeltaMinor), inputRefs: assumptionInputRefs },
    ],
    total: usd(totalMinor),
    sensitivity: kind === "baseline"
      ? { low: usd(totalMinor), base: usd(totalMinor), high: usd(totalMinor), calibratedProbability: false }
      : {
          low: usd(Math.round(totalMinor * 0.9)),
          base: usd(totalMinor),
          high: usd(Math.round(totalMinor * 1.1)),
          calibratedProbability: false,
        },
    coverageWarnings,
    completedAt: ctx.clock.now(),
  };
  history.push(snapshot);
  ctx.company.forecasts.set(forecastId, history);

  const forecastRef: RecordRef = { type: "forecast", id: forecastId, revision };
  const eligibleAt = ctx.clock.tick();
  const job: DurableJobMessage = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: ctx.company.organizationId,
    jobId: ctx.ids.next("job"),
    revision: 1,
    jobType: kind === "scenario" ? "scenario" : "forecast_refresh",
    originPrincipalId: ctx.principal.principalId,
    serviceIdentityId: "service_mock_api",
    scope: structuredClone(payload.scope),
    priority: "P1",
    state: "completed",
    inputVersions: [...postingRefs, ...correctionRefs, ...commitmentRefs],
    deduplicationKey: `forecast:${payload.scope.type}:${payload.scope.id}:${payload.asOfCutoff}`,
    currentStep: "snapshot_persisted",
    checkpointRefs: [forecastRef],
    attempts: 1,
    eligibleAt,
    deadlineAt: null,
    lease: null,
  };

  const activityScopes: ScopeRef[] = [ctx.company.registry.tenantScope, payload.scope];
  appendActivity(ctx, {
    activityId: ctx.ids.next("activity"),
    type: "job",
    occurredAt: job.eligibleAt,
    subjectRef: { type: "job", id: job.jobId, revision: 1 },
    summary: jobSummary(job),
  }, activityScopes);
  appendActivity(ctx, {
    activityId: ctx.ids.next("activity"),
    type: "forecast",
    occurredAt: snapshot.completedAt,
    subjectRef: forecastRef,
    summary: forecastSummary(snapshot),
  }, activityScopes);
  return { job, acceptedAt: eligibleAt };
};

export const getForecast: Handler<"forecasts.get"> = (ctx, payload) => {
  const snapshot = ctx.company.forecasts.get(payload.forecastId)?.at(-1);
  if (!snapshot) {
    throw new MockContractError("NOT_FOUND", `forecast ${payload.forecastId} has no snapshot for ${ctx.company.organizationId}`);
  }
  return snapshot;
};
