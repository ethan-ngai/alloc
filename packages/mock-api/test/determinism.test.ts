import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import { northstarPack } from "../src/packs.js";
import type { OperationName } from "@alloc/contracts";
import {
  commandMeta, companyFixture, parseResult, postOperation, queryMeta, startMock, versionExpectation,
} from "./harness.js";
import type { MockHeaders } from "./harness.js";

const company = companyFixture(northstarPack);
const ORG = company.organizationId;
const OCCURRED_AT = "2026-09-12T14:30:00Z";

/**
 * One scripted sequence of every state-changing path, including an error response and an
 * idempotent replay. Two independent servers must produce byte-identical canonical JSON for it.
 */
async function runSequence(url: string): Promise<string[]> {
  const observed: string[] = [];
  const send = async <Name extends OperationName>(name: Name, input: unknown, headers: MockHeaders = {}) => {
    const response = await postOperation(url, name, input, headers);
    observed.push(canonicalJson(response.body));
    return { status: response.status, result: parseResult(name, response.body) };
  };

  await send("requests.get", { meta: queryMeta("correlation_determinism_get", ORG), payload: { requestId: company.requestId } });
  await send("requests.amend", {
    meta: commandMeta("command_determinism_amend_1", "correlation_determinism_amend_1", ORG, [
      versionExpectation({ type: "request", id: company.requestId }, 1),
    ]),
    payload: { requestId: company.requestId, revisedFullAmount: { amountMinor: 21_000, currency: "USD" }, reason: "Additional pilot-day lodging" },
  });
  await send("requests.amend", {
    meta: commandMeta("command_determinism_amend_2", "correlation_determinism_amend_2", ORG, [
      versionExpectation({ type: "request", id: company.requestId }, 2),
    ]),
    payload: { requestId: company.requestId, revisedFullAmount: { amountMinor: 24_000, currency: "USD" }, reason: "Revised ground transportation" },
  });
  const decided = await send("reviews.decide", {
    meta: commandMeta("command_determinism_decide", "correlation_determinism_decide", ORG),
    payload: { requestId: company.requestId, requestRevision: 3, outcome: "approved", rationale: "Reviewed" },
  }, { principalId: company.approverId });
  const commitmentRevision = decided.result.ok ? decided.result.data.commitment?.revision ?? 1 : 1;

  await send("postings.record", {
    meta: commandMeta("command_determinism_posting", "correlation_determinism_posting", ORG, [
      versionExpectation({ type: "commitment", id: company.commitmentId }, commitmentRevision),
    ]),
    payload: {
      postingId: "posting_determinism_trip",
      revision: 1,
      amount: { amountMinor: 24_000, currency: "USD" },
      occurredAt: OCCURRED_AT,
      status: "posted",
      commitmentRef: { type: "commitment", id: company.commitmentId, revision: commitmentRevision },
      sourceRef: { type: "source_delivery", id: "delivery_determinism_trip", revision: 1 },
      scopes: company.requestScopes,
      provenance: {
        kind: "synthetic",
        trust: "authoritative",
        sourceInstanceId: "source_determinism_driver",
        sourceObjectId: "determinism-trip",
        sourceRevision: "1",
        occurredAt: OCCURRED_AT,
        observedAt: OCCURRED_AT,
      },
    },
  });
  await send("memory.query", {
    meta: queryMeta("correlation_determinism_memory", ORG),
    payload: { query: "travel", scopes: [company.tenantScope, company.departmentScope], page: { limit: 25 } },
  });
  await send("forecasts.run", {
    meta: commandMeta("command_determinism_forecast", "correlation_determinism_forecast", ORG),
    payload: { scope: company.departmentScope, asOfCutoff: "2026-09-12T14:00:00Z", horizonEnd: "2026-09-30T23:59:59Z", assumptions: [] },
  });
  await send("forecasts.get", { meta: queryMeta("correlation_determinism_forecast_get", ORG), payload: { forecastId: "forecast_field_engineering" } });
  await send("activity.list", { meta: queryMeta("correlation_determinism_activity", ORG), payload: { scopes: [company.tenantScope], page: { limit: 25 } } });
  await send("imports.ingest", {
    meta: commandMeta("command_determinism_ingest", "correlation_determinism_ingest", ORG),
    payload: {
      sourceInstanceId: "source_determinism_ledger",
      deliveryId: "delivery-determinism-1",
      sourceObjectId: "determinism-expense-1",
      sourceRevision: "1",
      eventType: "expense_recorded",
      occurredAt: OCCURRED_AT,
      observedAt: OCCURRED_AT,
      isSynthetic: true,
      provenance: {
        kind: "synthetic",
        trust: "authoritative",
        sourceInstanceId: "source_determinism_driver",
        sourceObjectId: "determinism-expense-1",
        sourceRevision: "1",
        occurredAt: OCCURRED_AT,
        observedAt: OCCURRED_AT,
      },
      payload: { amountMinor: 1_500, currency: "USD" },
    },
  });
  await send("requests.get", { meta: queryMeta("correlation_determinism_missing", ORG), payload: { requestId: "request_determinism_missing" } });
  const replayInput = {
    meta: commandMeta("command_determinism_replay", "correlation_determinism_replay", ORG),
    payload: {
      requesterId: company.requesterId,
      purpose: "Determinism probe",
      fullAmount: { amountMinor: 1_000, currency: "USD" },
      categoryId: company.categoryIds[0],
      scopes: company.requestScopes,
    },
  };
  await send("requests.create", replayInput);
  await send("requests.create", replayInput);
  return observed;
}

describe("determinism", () => {
  it("produces byte-identical canonical responses on two independent servers", async () => {
    const first = await startMock();
    const second = await startMock();
    try {
      const left = await runSequence(first.url);
      const right = await runSequence(second.url);
      expect(left).toHaveLength(13);
      expect(left).toEqual(right);
      expect(left.some((body) => body.includes('"ok":false'))).toBe(true);
    } finally {
      await first.api.close();
      await second.api.close();
    }
  });
});
