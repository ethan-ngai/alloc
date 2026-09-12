import { randomUUID } from "node:crypto";
import { IdSchema } from "@alloc/contracts";
import type { FastifyRequest } from "fastify";

export const CORRELATION_ID_HEADER = "x-correlation-id";

/** Generates a correlation ID that satisfies the shared `IdSchema` contract. */
export function generateCorrelationId(): string {
  return `corr_${randomUUID().replaceAll("-", "")}`;
}

/**
 * Reuses a caller-supplied correlation ID only when it is a valid contract ID;
 * anything else is replaced so arbitrary header text cannot reach logs.
 */
export function resolveCorrelationId(header: unknown): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  if (typeof candidate === "string") {
    const parsed = IdSchema.safeParse(candidate);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return generateCorrelationId();
}

/** Correlation ID of a request, generating one when no hook has run yet. */
export function correlationIdOf(request: FastifyRequest): string {
  return request.correlationId ?? generateCorrelationId();
}

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string | null;
  }
}
