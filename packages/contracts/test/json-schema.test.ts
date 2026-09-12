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
