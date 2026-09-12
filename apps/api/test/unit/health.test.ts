import { operationResult } from "@alloc/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createReadiness, type Readiness } from "../../src/readiness.js";
import { buildTestApp } from "../support/app.js";

const LiveResultSchema = operationResult(z.strictObject({ status: z.literal("live") }));
const ReadyResultSchema = operationResult(z.strictObject({ status: z.literal("ready") }));

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("liveness", () => {
  it("answers without authentication and without claiming database availability", async () => {
    const app = newTestApp();
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    const parsed = LiveResultSchema.parse(response.json());
    expect(parsed).toMatchObject({ ok: true, data: { status: "live" } });
    expect(response.json()).not.toHaveProperty("ready");
  });

  it("stays live while the process is not ready", async () => {
    const app = newTestApp(createReadiness());
    const notReady = await app.inject({ method: "GET", url: "/health/live" });

    expect(notReady.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(503);
  });
});

describe("readiness", () => {
  it("returns 200 only once the database, validators, and indexes are ready", async () => {
    const app = newTestApp();
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(ReadyResultSchema.parse(response.json())).toMatchObject({ ok: true, data: { status: "ready" } });
  });

  it("returns a redacted 503 before the dependency is ready", async () => {
    const readiness = createReadiness();
    readiness.markNotReady("mongodb://admin:hunter2@127.0.0.1:27017 is unreachable");
    const app = newTestApp(readiness);
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "DEPENDENCY_UNAVAILABLE", retryable: true } });
    expect(response.body).not.toContain("hunter2");
    expect(response.body).not.toContain("27017");
  });

  it("returns 503 again once readiness is withdrawn", async () => {
    const readiness = createReadiness();
    readiness.markReady();
    const app = newTestApp(readiness);

    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);

    readiness.markNotReady("shutting down");
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(503);
  });
});

describe("unknown routes", () => {
  it("returns the shared error envelope with a correlation ID", async () => {
    const app = newTestApp();
    const response = await app.inject({ method: "GET", url: "/v1/unknown" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(response.headers["x-correlation-id"]).toBe(response.json().correlationId);
  });
});

function newTestApp(readiness?: Readiness): FastifyInstance {
  const { app } = buildTestApp(readiness ? { readiness } : {});
  apps.push(app);
  return app;
}
