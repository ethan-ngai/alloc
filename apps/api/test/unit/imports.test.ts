import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SourceDelivery } from "@alloc/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ImportRepository } from "../../src/imports/repository.js";
import { buildTestApp, signTestToken } from "../support/app.js";

const fixturePath = fileURLToPath(new URL("../../../../packages/company-fixtures/fixtures/northstar.json", import.meta.url));
const delivery = (JSON.parse(readFileSync(fixturePath, "utf8")) as { deliveries: SourceDelivery[] }).deliveries[0]!;
const url = "/v1/organizations/org_northstar/imports";
const apps: FastifyInstance[] = [];

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("import HTTP transport", () => {
  it("accepts the shared JSON command envelope and derives the tenant from the token", async () => {
    const seen: SourceDelivery[] = [];
    const app = testApp(seen);
    const response = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${await signTestToken()}` }, payload: command(delivery) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, data: { disposition: "accepted" } });
    expect(seen).toEqual([delivery]);
  });

  it("accepts the equivalent single-delivery CSV transport", async () => {
    const seen: SourceDelivery[] = [];
    const app = testApp(seen);
    const response = await app.inject({ method: "POST", url: `${url}/csv`, headers: { authorization: `Bearer ${await signTestToken()}`, "content-type": "text/csv" }, payload: `delivery\n"${JSON.stringify(delivery).replaceAll('"', '""')}"` });
    expect(response.statusCode).toBe(200);
    expect(seen).toEqual([delivery]);
  });

  it("blocks a command whose claimed organization differs from the signed token", async () => {
    const app = testApp([]);
    const response = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${await signTestToken()}` }, payload: { ...command(delivery), meta: { ...command(delivery).meta, organizationId: "org_juniper" } } });
    expect(response.statusCode).toBe(403);
  });
});

function testApp(seen: SourceDelivery[]): FastifyInstance {
  const imports: ImportRepository = {
    async ingest(value) { seen.push(value); return { deliveryRef: { type: "source_delivery", id: "delivery_test", revision: 1 }, disposition: "accepted", normalizedRefs: [] }; },
    async listPostings() { return []; }, async seedEntities() {}, async seedMappings() {},
  };
  const { app } = buildTestApp({ imports });
  apps.push(app);
  return app;
}

function command(value: SourceDelivery) {
  const { organizationId: _organizationId, schemaVersion: _schemaVersion, ...payload } = value;
  return { meta: { schemaVersion: "1.0.0", organizationId: "org_northstar", commandId: "command_import_test", correlationId: "correlation_import_test", expectedVersions: [] }, payload };
}
