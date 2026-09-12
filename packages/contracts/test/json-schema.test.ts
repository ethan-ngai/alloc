import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";
import { generateJsonSchemas } from "../src/json-schema.js";
import { contractExamples, northstarScenario } from "../src/fixtures.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

describe("JSON Schema compatibility", () => {
  it("compiles every exported draft 2020-12 schema", () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    for (const schema of Object.values(generateJsonSchemas())) expect(() => ajv.compile(schema)).not.toThrow();
  });

  it("validates representative serialized values with independent JSON Schema tooling", () => {
    const schemas = generateJsonSchemas();
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    expect(ajv.compile(schemas.PurchaseRequestRevisionSchema!)(JSON.parse(JSON.stringify(northstarScenario.requestRevisions[2])))).toBe(true);
    expect(ajv.compile(schemas.EventEnvelopeSchema!)(JSON.parse(JSON.stringify(contractExamples.event)))).toBe(true);
    expect(ajv.compile(schemas.ContractErrorSchema!)(JSON.parse(JSON.stringify(contractExamples.errors.unknownOutcome)))).toBe(true);
    expect(ajv.compile(schemas.OrganizationIdSchema!)("employee_maya_chen")).toBe(false);
    expect(ajv.compile(schemas.SignedNonZeroMoneySchema!)({ amountMinor: 0, currency: "USD" })).toBe(false);
    expect(ajv.compile(schemas.ForecastSnapshotSchema!)(JSON.parse(JSON.stringify(contractExamples.reductionForecast)))).toBe(true);

    const proposal = { requestId: "request_buffalo_trip", requestRevision: 3, type: "simulate_purchase", rationale: "Proceed", evidenceRefs: [] };
    const validateProposal = ajv.compile(schemas.ProposeActionToolInputSchema!);
    expect(validateProposal(proposal)).toBe(false);
    expect(validateProposal({ ...proposal, amount: { amountMinor: 24_000, currency: "USD" } })).toBe(true);
    expect(validateProposal({ ...proposal, type: "cancel_request", amount: { amountMinor: 24_000, currency: "USD" } })).toBe(false);
    expect(validateProposal({ ...proposal, type: "cancel_request" })).toBe(true);

    const assumptionBase = {
      assumptionId: "assumption_usage", name: "Adjust usage", scope: { type: "project", id: "project_beacon" },
      effectiveFrom: "2026-09-13T00:00:00Z", effectiveTo: "2026-09-30T23:59:59Z", evidenceRefs: [],
    };
    const validateAssumption = ajv.compile(schemas.ForecastAssumptionSchema!);
    expect(validateAssumption({ ...assumptionBase, kind: "fixed_adjustment" })).toBe(false);
    expect(validateAssumption({ ...assumptionBase, kind: "fixed_adjustment", amount: { amountMinor: -3_000, currency: "USD" } })).toBe(true);
    expect(validateAssumption({ ...assumptionBase, kind: "percentage_change" })).toBe(false);
    expect(validateAssumption({ ...assumptionBase, kind: "percentage_change", valueBasisPoints: -2_000 })).toBe(true);
    expect(validateAssumption({ ...assumptionBase, kind: "timing_shift", targetRef: { type: "schedule", id: "schedule_cloud" }, shiftDays: 7 })).toBe(false);
    expect(validateAssumption({ ...assumptionBase, kind: "timing_shift", targetRef: { type: "schedule", id: "schedule_cloud", revision: 1 }, shiftDays: 7 })).toBe(true);

    const reviewInput = {
      meta: {
        schemaVersion: "1.0.0", organizationId: "org_northstar", commandId: "command_review_buffalo",
        correlationId: "correlation_buffalo_trip", expectedVersions: [],
      },
      payload: { requestId: "request_buffalo_trip", requestRevision: 3, outcome: "approved", rationale: "Approved" },
    };
    const validateReview = ajv.compile(schemas.DecideReviewInputSchema!);
    expect(validateReview(reviewInput)).toBe(true);
    expect(validateReview({ ...reviewInput, payload: { ...reviewInput.payload, grant: northstarScenario.approvalGrant } })).toBe(false);
  });

  it("exposes checked-in JSON Schemas through the package export map", async () => {
    const schemaPath = require.resolve("@alloc/contracts/schemas/ForecastSnapshotSchema.schema.json");
    expect(JSON.parse(await readFile(schemaPath, "utf8")).title).toBe("ForecastSnapshotSchema");
  });

  it("keeps checked-in schema output synchronized", async () => {
    for (const [name, schema] of Object.entries(generateJsonSchemas())) {
      const file = await readFile(resolve("schemas", `${name}.schema.json`), "utf8");
      expect(JSON.parse(file)).toEqual(schema);
    }
    expect(JSON.parse(await readFile(resolve("fixtures", "northstar-scenario.json"), "utf8"))).toEqual(northstarScenario);
    expect(JSON.parse(await readFile(resolve("fixtures", "representative-examples.json"), "utf8"))).toEqual(contractExamples);
  });
});
