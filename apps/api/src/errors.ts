import { CONTRACT_SCHEMA_VERSION, ContractErrorSchema, operationResult } from "@alloc/contracts";
import { MongoError } from "mongodb";
import { SourceConflictError } from "./imports/repository.js";
import { ContextQueryError } from "./context/repository.js";
import { GraphAccessError } from "./context/graph.js";
import { z } from "zod";

export type ErrorCode = z.infer<typeof ContractErrorSchema>["code"];
export type ContractError = z.infer<typeof ContractErrorSchema>;

/** An error that maps directly onto `ContractErrorSchema` and an HTTP status. */
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly code: ErrorCode,
    readonly statusCode: number,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const apiErrors = {
  validation: (message: string) => new ApiError("VALIDATION_FAILED", 400, message, false),
  unauthenticated: () => new ApiError("ACCESS_DENIED", 401, "Authentication required", false),
  forbidden: () => new ApiError("ACCESS_DENIED", 403, "Access denied", false),
  notFound: (message: string) => new ApiError("NOT_FOUND", 404, message, false),
  dependencyUnavailable: (message: string) => new ApiError("DEPENDENCY_UNAVAILABLE", 503, message, true),
  sourceConflict: () => new ApiError("SOURCE_CONFLICT", 409, "Source delivery conflicts with an existing record", false),
  internal: () => new ApiError("INTERNAL_ERROR", 500, "Internal server error", false),
} as const;

export interface SuccessEnvelope<T> {
  readonly ok: true;
  readonly schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  readonly correlationId: string;
  readonly data: T;
}

/** Any well-formed operation-result envelope, validated against the 1A contract. */
const AnyResultSchema = operationResult(z.unknown());

export function successEnvelope<T>(correlationId: string, data: T): SuccessEnvelope<T> {
  return { ok: true, schemaVersion: CONTRACT_SCHEMA_VERSION, correlationId, data };
}

/**
 * Builds and validates the failure envelope. The result is checked against the
 * shared `operationResult` contract so an internal mistake cannot ship a
 * malformed error body.
 */
export function errorEnvelope(correlationId: string, error: ApiError): Record<string, unknown> {
  const envelope = {
    ok: false as const,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    correlationId,
    error: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      correlationId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  const parsed = AnyResultSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new Error("constructed error envelope violates the shared operation-result contract");
  }
  return envelope;
}

/**
 * Maps an arbitrary failure onto the shared error contract. Unknown errors
 * become a generic internal error: driver messages, stack traces, credentials,
 * and bearer tokens never reach a response.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof SourceConflictError) return apiErrors.sourceConflict();
  if (error instanceof ContextQueryError) return apiErrors.validation("Invalid memory query");
  if (error instanceof GraphAccessError) return apiErrors.forbidden();
  if (error instanceof MongoError) {
    return apiErrors.dependencyUnavailable("Database unavailable");
  }

  const statusCode = statusCodeOf(error);
  switch (statusCode) {
    case 400:
    case 413:
    case 415:
    case 422:
      return apiErrors.validation("Request validation failed");
    case 401:
      return apiErrors.unauthenticated();
    case 403:
      return apiErrors.forbidden();
    case 404:
      return apiErrors.notFound("Resource not found");
    case 503:
      return apiErrors.dependencyUnavailable("Dependency unavailable");
    default:
      return apiErrors.internal();
  }
}

/** Redacted, log-safe view of a failure. */
export function describeError(error: unknown, redact: (text: string) => string): {
  name: string;
  message: string;
  stack: string;
} {
  const normalized = error instanceof Error ? error : new Error(typeof error === "string" ? error : "unknown error");
  return {
    name: normalized.name,
    message: redact(normalized.message),
    stack: redact(normalized.stack ?? ""),
  };
}

function statusCodeOf(error: unknown): number | null {
  if (error && typeof error === "object") {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") {
      return statusCode;
    }
  }
  return null;
}
