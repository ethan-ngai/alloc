import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTRACT_SCHEMA_VERSION, ContractErrorSchema, OperationSchemas } from "@alloc/contracts";
import type { OperationInput, OperationName, OperationResult } from "@alloc/contracts";
import type { z } from "zod";
import { createMockApi } from "./api.js";
import { MOCK_FAULT_HEADER, MOCK_PRINCIPAL_HEADER } from "./client.js";
import { DEFAULT_MOCK_CLOCK } from "./clock.js";
import type { ErrorCode } from "./errors.js";

const FIXTURES_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const ORGANIZATION_ID = "org_northstar";
const REQUEST_ID = "request_buffalo_trip";
const COMMITMENT_ID = "commitment_buffalo_trip";
const FORECAST_ID = "forecast_field_engineering";
const HORIZON_END = "2026-09-30T23:59:59Z";
const OCCURRED_AT = "2026-09-12T14:20:00Z";
const TENANT_SCOPE = { type: "organization", id: ORGANIZATION_ID } as const;
const DEPARTMENT_SCOPE = { type: "department", id: "department_field_engineering" } as const;
const PROJECT_SCOPE = { type: "project", id: "project_beacon" } as const;

interface RawReply {
  status: number;
  body: unknown;
}

interface CallOptions {
  principalId?: string;
  fault?: ErrorCode;
}

interface OkFixture {
  file: string;
  operation: OperationName;
  variant: string;
  ok: true;
}

interface ErrorFixture {
  file: string;
  schema: "ContractError";
  errorCode: ErrorCode;
  variant: string;
}

function queryMeta(correlationId: string) {
  return { schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: ORGANIZATION_ID, correlationId };
}

function commandMeta(commandId: string, correlationId: string, expectedVersions: unknown[] = []) {
  return { schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: ORGANIZATION_ID, commandId, correlationId, expectedVersions };
}

function provenance(sourceObjectId: string) {
  return {
    kind: "synthetic" as const,
    trust: "authoritative" as const,
    sourceInstanceId: "source_fixture_driver",
    sourceObjectId,
    sourceRevision: "1",
    occurredAt: OCCURRED_AT,
    observedAt: OCCURRED_AT,
  };
}

async function sendRaw(url: string, operation: OperationName, body: string, options: CallOptions = {}): Promise<RawReply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.principalId !== undefined) headers[MOCK_PRINCIPAL_HEADER] = options.principalId;
  if (options.fault !== undefined) headers[MOCK_FAULT_HEADER] = options.fault;
  const response = await fetch(`${url}/operations/${operation}`, { method: "POST", headers, body });
  return { status: response.status, body: JSON.parse(await response.text()) as unknown };
}

async function call<Name extends OperationName>(
  url: string,
  name: Name,
  input: OperationInput<Name>,
  options: CallOptions = {},
): Promise<OperationResult<Name>> {
  const reply = await sendRaw(url, name, JSON.stringify(input), options);
  const schema = OperationSchemas[name].result as unknown as z.ZodType<unknown>;
  const parsed = schema.safeParse(reply.body);
  if (!parsed.success) throw new Error(`fixture driver: ${name} produced a body that violates its contract`);
  return parsed.data as OperationResult<Name>;
}

function requestIdOf(body: unknown): string {
  const parsed = OperationSchemas["requests.create"].result.safeParse(body);
  if (!parsed.success || !parsed.data.ok) throw new Error("fixture driver: expected a created request");
  return parsed.data.data.requestId;
}

function errorCodeOf(body: unknown): ErrorCode {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    throw new Error("fixture driver: expected an error envelope");
  }
  return ContractErrorSchema.parse(body.error).code;
}

function isOkEnvelope(body: unknown): boolean {
  return body !== null && typeof body === "object" && "ok" in body && body.ok === true;
}

async function reset(url: string): Promise<void> {
  const response = await fetch(`${url}/admin/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`fixture driver: reset returned HTTP ${response.status}`);
}

/**
 * Drives the mock over real HTTP in a fixed order and returns fixture path → pretty JSON. The same
 * function backs `npm run fixtures:export`, the committed fixtures, and the drift test, so a change
 * in mock behaviour shows up as a fixture diff rather than as a silent frontend mismatch.
 */
export async function exportFixtures(options: { write?: boolean } = {}): Promise<Record<string, string>> {
  const api = createMockApi({ clock: DEFAULT_MOCK_CLOCK });
  const { url } = await api.listen(0);
  const files: Record<string, string> = {};
  const okFixtures: OkFixture[] = [];
  const errorFixtures: ErrorFixture[] = [];

  const record = (path: string, reply: RawReply, operation: OperationName, variant: string): void => {
    if (!isOkEnvelope(reply.body)) throw new Error(`fixture driver: ${path} is not an ok response`);
    files[path] = `${JSON.stringify(reply.body, null, 2)}\n`;
    okFixtures.push({ file: path, operation, variant, ok: true });
  };
  const recordError = (path: string, reply: RawReply, variant: string): void => {
    files[path] = `${JSON.stringify(reply.body, null, 2)}\n`;
    errorFixtures.push({ file: path, schema: "ContractError", errorCode: errorCodeOf(reply.body), variant });
  };

  try {
    // Group A — the seeded request is already approved at revision 1.
    record("northstar/requests.amend.approved.json", await sendRaw(url, "requests.amend", JSON.stringify({
      meta: commandMeta("command_fixture_amend_1", "correlation_fixture_amend_1", [{ ref: { type: "request", id: REQUEST_ID }, expectedRevision: 1 }]),
      payload: { requestId: REQUEST_ID, revisedFullAmount: { amountMinor: 21_000, currency: "USD" }, reason: "Additional pilot-day lodging" },
    })), "requests.amend", "approved");

    record("northstar/requests.amend.review_required.json", await sendRaw(url, "requests.amend", JSON.stringify({
      meta: commandMeta("command_fixture_amend_2", "correlation_fixture_amend_2", [{ ref: { type: "request", id: REQUEST_ID }, expectedRevision: 2 }]),
      payload: { requestId: REQUEST_ID, revisedFullAmount: { amountMinor: 24_000, currency: "USD" }, reason: "Revised ground transportation" },
    })), "requests.amend", "review_required");

    record("northstar/requests.get.review_required.json", await sendRaw(url, "requests.get", JSON.stringify({
      meta: queryMeta("correlation_fixture_get_review_required"),
      payload: { requestId: REQUEST_ID },
    })), "requests.get", "review_required");

    record("northstar/reviews.decide.approved.json", await sendRaw(url, "reviews.decide", JSON.stringify({
      meta: commandMeta("command_fixture_decide_approved", "correlation_fixture_decide_approved"),
      payload: { requestId: REQUEST_ID, requestRevision: 3, outcome: "approved", rationale: "Reviewed and approved for the Beacon pilot" },
    }), { principalId: "employee_avery_finance" }), "reviews.decide", "approved");

    const afterApproval = await call(url, "requests.get", {
      meta: queryMeta("correlation_fixture_get_after_approval"),
      payload: { requestId: REQUEST_ID },
    });
    if (!afterApproval.ok || afterApproval.data.commitment === null) {
      throw new Error("fixture driver: expected an approved commitment after human review");
    }
    const commitmentRevision = afterApproval.data.commitment.revision;

    record("northstar/postings.record.matched.json", await sendRaw(url, "postings.record", JSON.stringify({
      meta: commandMeta("command_fixture_record_posting", "correlation_fixture_record_posting", [{ ref: { type: "commitment", id: COMMITMENT_ID }, expectedRevision: commitmentRevision }]),
      payload: {
        postingId: "posting_fixture_trip_lodging",
        revision: 1,
        amount: { amountMinor: 24_000, currency: "USD" },
        occurredAt: OCCURRED_AT,
        status: "posted",
        commitmentRef: { type: "commitment", id: COMMITMENT_ID, revision: commitmentRevision },
        sourceRef: { type: "source_delivery", id: "delivery_fixture_lodging", revision: 1 },
        scopes: [TENANT_SCOPE, DEPARTMENT_SCOPE, PROJECT_SCOPE],
        provenance: provenance("fixture-trip-lodging"),
      },
    })), "postings.record", "matched");

    record("northstar/postings.correct.json", await sendRaw(url, "postings.correct", JSON.stringify({
      meta: commandMeta("command_fixture_correct_posting", "correlation_fixture_correct_posting", [{ ref: { type: "posting", id: "posting_fixture_trip_lodging" }, expectedRevision: 1 }]),
      payload: {
        correctionId: "correction_fixture_trip_lodging",
        originalPostingRef: { type: "posting", id: "posting_fixture_trip_lodging", revision: 1 },
        amount: { amountMinor: -2_000, currency: "USD" },
        reason: "One pilot day was refunded",
        occurredAt: OCCURRED_AT,
        provenance: provenance("fixture-trip-lodging-correction"),
      },
    })), "postings.correct", "corrected");

    record("northstar/requests.get.approved.json", await sendRaw(url, "requests.get", JSON.stringify({
      meta: queryMeta("correlation_fixture_get_approved"),
      payload: { requestId: REQUEST_ID },
    })), "requests.get", "approved");

    record("northstar/memory.query.json", await sendRaw(url, "memory.query", JSON.stringify({
      meta: queryMeta("correlation_fixture_memory_query"),
      payload: { query: "travel", scopes: [TENANT_SCOPE, DEPARTMENT_SCOPE], page: { limit: 25 } },
    })), "memory.query", "travel");

    record("northstar/forecasts.run.baseline.json", await sendRaw(url, "forecasts.run", JSON.stringify({
      meta: commandMeta("command_fixture_forecast_baseline", "correlation_fixture_forecast_baseline"),
      payload: { scope: DEPARTMENT_SCOPE, asOfCutoff: DEFAULT_MOCK_CLOCK, horizonEnd: HORIZON_END, assumptions: [] },
    })), "forecasts.run", "baseline");

    record("northstar/forecasts.get.baseline.json", await sendRaw(url, "forecasts.get", JSON.stringify({
      meta: queryMeta("correlation_fixture_get_forecast_baseline"),
      payload: { forecastId: FORECAST_ID },
    })), "forecasts.get", "baseline");

    await sendRaw(url, "forecasts.run", JSON.stringify({
      meta: commandMeta("command_fixture_forecast_scenario", "correlation_fixture_forecast_scenario"),
      payload: {
        scope: DEPARTMENT_SCOPE,
        asOfCutoff: DEFAULT_MOCK_CLOCK,
        horizonEnd: HORIZON_END,
        assumptions: [{
          assumptionId: "assumption_fixture_reduce_travel",
          name: "Reduce pilot travel by 20%",
          kind: "percentage_change",
          valueBasisPoints: -2_000,
          scope: PROJECT_SCOPE,
          effectiveFrom: "2026-09-13T00:00:00Z",
          effectiveTo: HORIZON_END,
          evidenceRefs: [{ type: "evidence", id: "evidence_trip_active", revision: 1 }],
        }],
      },
    }));

    record("northstar/forecasts.get.scenario.json", await sendRaw(url, "forecasts.get", JSON.stringify({
      meta: queryMeta("correlation_fixture_get_forecast_scenario"),
      payload: { forecastId: FORECAST_ID },
    })), "forecasts.get", "scenario");

    record("northstar/activity.list.json", await sendRaw(url, "activity.list", JSON.stringify({
      meta: queryMeta("correlation_fixture_activity_list"),
      payload: { scopes: [TENANT_SCOPE], page: { limit: 25 } },
    })), "activity.list", "organization");

    const delivery = {
      meta: commandMeta("command_fixture_ingest", "correlation_fixture_ingest"),
      payload: {
        sourceInstanceId: "source_fixture_ledger",
        deliveryId: "delivery-fixture-expense-1",
        sourceObjectId: "fixture-expense-1",
        sourceRevision: "1",
        eventType: "expense_recorded",
        occurredAt: OCCURRED_AT,
        observedAt: OCCURRED_AT,
        isSynthetic: true,
        provenance: provenance("fixture-expense-1"),
        payload: { amountMinor: 4_500, currency: "USD" },
      },
    };
    record("northstar/imports.ingest.accepted.json", await sendRaw(url, "imports.ingest", JSON.stringify(delivery)), "imports.ingest", "accepted");
    record("northstar/imports.ingest.duplicate.json", await sendRaw(url, "imports.ingest", JSON.stringify({
      ...delivery,
      meta: commandMeta("command_fixture_ingest_replay", "correlation_fixture_ingest_replay"),
    })), "imports.ingest", "duplicate");
    record("northstar/imports.ingest.quarantined.json", await sendRaw(url, "imports.ingest", JSON.stringify({
      ...delivery,
      meta: commandMeta("command_fixture_ingest_quarantined", "correlation_fixture_ingest_quarantined"),
      payload: { ...delivery.payload, sourceObjectId: "fixture-unknown-1", eventType: "unknown_event" },
    })), "imports.ingest", "quarantined");

    // Group B — fresh state so the budget arithmetic of created requests is exact.
    await reset(url);

    const approvedCreate = await sendRaw(url, "requests.create", JSON.stringify({
      meta: commandMeta("command_fixture_create_approved", "correlation_fixture_create_approved"),
      payload: {
        requesterId: "employee_maya_chen",
        purpose: "Buffalo Beacon pilot trip",
        fullAmount: { amountMinor: 18_000, currency: "USD" },
        categoryId: "category_travel",
        vendorId: "vendor_buffalo_hotel",
        projectId: "project_beacon",
        scopes: [TENANT_SCOPE, DEPARTMENT_SCOPE, PROJECT_SCOPE],
      },
    }));
    record("northstar/requests.create.approved.json", approvedCreate, "requests.create", "approved");

    const deniedCreate = await sendRaw(url, "requests.create", JSON.stringify({
      meta: commandMeta("command_fixture_create_denied", "correlation_fixture_create_denied"),
      payload: {
        requesterId: "employee_maya_chen",
        purpose: "Full field-lab relocation",
        fullAmount: { amountMinor: 150_000, currency: "USD" },
        categoryId: "category_equipment",
        vendorId: "vendor_buffalo_hotel",
        projectId: "project_beacon",
        scopes: [TENANT_SCOPE, DEPARTMENT_SCOPE, PROJECT_SCOPE],
      },
    }));
    record("northstar/requests.create.denied.json", deniedCreate, "requests.create", "denied");

    record("northstar/requests.get.denied.json", await sendRaw(url, "requests.get", JSON.stringify({
      meta: queryMeta("correlation_fixture_get_denied"),
      payload: { requestId: requestIdOf(deniedCreate.body) },
    })), "requests.get", "denied");

    const reviewCreate = await sendRaw(url, "requests.create", JSON.stringify({
      meta: commandMeta("command_fixture_create_review", "correlation_fixture_create_review"),
      payload: {
        requesterId: "employee_maya_chen",
        purpose: "Extended pilot equipment rental",
        fullAmount: { amountMinor: 30_000, currency: "USD" },
        categoryId: "category_equipment",
        vendorId: "vendor_buffalo_hotel",
        projectId: "project_beacon",
        scopes: [TENANT_SCOPE, DEPARTMENT_SCOPE, PROJECT_SCOPE],
      },
    }));
    const reviewRequestId = requestIdOf(reviewCreate.body);

    record("northstar/reviews.decide.denied.json", await sendRaw(url, "reviews.decide", JSON.stringify({
      meta: commandMeta("command_fixture_decide_denied", "correlation_fixture_decide_denied"),
      payload: { requestId: reviewRequestId, requestRevision: 1, outcome: "denied", rationale: "Outside the approved pilot scope" },
    }), { principalId: "employee_avery_finance" }), "reviews.decide", "denied");

    // Failure fixtures.
    recordError("errors/stale-version.json", await sendRaw(url, "requests.amend", JSON.stringify({
      meta: commandMeta("command_fixture_stale", "correlation_fixture_stale", [{ ref: { type: "request", id: REQUEST_ID }, expectedRevision: 2 }]),
      payload: { requestId: REQUEST_ID, revisedFullAmount: { amountMinor: 21_000, currency: "USD" }, reason: "Stale client amendment" },
    })), "stale-version");

    recordError("errors/authority-denied.json", await sendRaw(url, "reviews.decide", JSON.stringify({
      meta: commandMeta("command_fixture_authority", "correlation_fixture_authority"),
      payload: { requestId: REQUEST_ID, requestRevision: 1, outcome: "approved", rationale: "Requester self-approval attempt" },
    }), { principalId: "employee_maya_chen" }), "authority-denied");

    recordError("errors/not-found.json", await sendRaw(url, "requests.get", JSON.stringify({
      meta: queryMeta("correlation_fixture_not_found"),
      payload: { requestId: "request_fixture_missing" },
    })), "not-found");

    recordError("errors/validation-failed.json", await sendRaw(url, "requests.get", "{"), "validation-failed");

    recordError("errors/dependency-unavailable.json", await sendRaw(url, "requests.get", JSON.stringify({
      meta: queryMeta("correlation_fixture_fault"),
      payload: { requestId: REQUEST_ID },
    }), { fault: "DEPENDENCY_UNAVAILABLE" }), "dependency-unavailable");

    const conflictPayload = {
      requesterId: "employee_maya_chen",
      purpose: "Idempotency probe",
      fullAmount: { amountMinor: 1_000, currency: "USD" },
      categoryId: "category_travel",
      scopes: [TENANT_SCOPE],
    };
    await sendRaw(url, "requests.create", JSON.stringify({
      meta: commandMeta("command_fixture_conflict", "correlation_fixture_conflict_first"),
      payload: conflictPayload,
    }));
    recordError("errors/idempotency-conflict.json", await sendRaw(url, "requests.create", JSON.stringify({
      meta: commandMeta("command_fixture_conflict", "correlation_fixture_conflict_second"),
      payload: { ...conflictPayload, fullAmount: { amountMinor: 2_000, currency: "USD" } },
    })), "idempotency-conflict");

    files["manifest.json"] = `${JSON.stringify({
      generatedBy: "packages/mock-api/src/export-fixtures.ts",
      clock: DEFAULT_MOCK_CLOCK,
      provisional: true,
      scenarioIds: api.health().scenarioIds,
      fixtures: [...okFixtures, ...errorFixtures],
    }, null, 2)}\n`;
  } finally {
    await api.close();
  }

  if (options.write ?? true) {
    await mkdir(FIXTURES_DIRECTORY, { recursive: true });
    for (const existing of await readdir(FIXTURES_DIRECTORY, { recursive: true })) {
      if (existing.endsWith(".json")) await rm(join(FIXTURES_DIRECTORY, existing));
    }
    for (const path of Object.keys(files).sort()) {
      const target = join(FIXTURES_DIRECTORY, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, files[path]!, "utf8");
    }
  }
  return files;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const written = await exportFixtures();
  process.stdout.write(`alloc-mock-api wrote ${Object.keys(written).length} fixtures to packages/mock-api/fixtures\n`);
}
