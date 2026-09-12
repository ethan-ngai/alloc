import { ErrorCodeSchema } from "@alloc/contracts";
import type { z } from "zod";

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Single source of truth for both real contract failures and `x-alloc-mock-fault` injection. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  VALIDATION_FAILED: 400,
  ACCESS_DENIED: 403,
  AUTHORITY_DENIED: 403,
  NOT_FOUND: 404,
  STALE_VERSION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  POLICY_DENIED: 409,
  SOURCE_DUPLICATE: 409,
  SOURCE_CONFLICT: 409,
  REVIEW_REQUIRED: 422,
  CAPACITY_EXCEEDED: 422,
  INTERNAL_ERROR: 500,
  OUTCOME_UNKNOWN: 502,
  DEPENDENCY_UNAVAILABLE: 503,
});

export const RETRYABLE_CODES: readonly ErrorCode[] = Object.freeze(["INTERNAL_ERROR", "DEPENDENCY_UNAVAILABLE"]);

export function errorStatus(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE_CODES.includes(code);
}

export function isErrorCode(value: string): value is ErrorCode {
  return ErrorCodeSchema.safeParse(value).success;
}

export class MockContractError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MockContractError";
    this.code = code;
    this.retryable = isRetryable(code);
    if (details !== undefined) this.details = details;
  }
}
