import { operationResult } from "@alloc/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { correlationIdOf } from "../correlation.js";
import { apiErrors, errorEnvelope, successEnvelope } from "../errors.js";
import type { Readiness } from "../readiness.js";

const LiveResultSchema = operationResult(z.strictObject({ status: z.literal("live") }));
const ReadyResultSchema = operationResult(z.strictObject({ status: z.literal("ready") }));

export function registerHealthRoutes(app: FastifyInstance, readiness: Readiness): void {
  // Liveness only: this endpoint never claims database availability.
  app.get("/health/live", async (request) =>
    LiveResultSchema.parse(successEnvelope(correlationIdOf(request), { status: "live" })),
  );

  app.get("/health/ready", async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const snapshot = readiness.snapshot();
    if (!snapshot.ready) {
      // The reason stays in the process log; the response is redacted.
      request.log.warn({ correlationId, reason: snapshot.reason ?? "unknown" }, "readiness probe failed");
      reply.code(503);
      return errorEnvelope(correlationId, apiErrors.dependencyUnavailable("Service is not ready"));
    }
    return ReadyResultSchema.parse(successEnvelope(correlationId, { status: "ready" }));
  });
}
