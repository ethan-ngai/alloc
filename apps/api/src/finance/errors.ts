import { ApiError } from "../errors.js";

/**
 * Semantic conflicts of the transactional financial core. Each one maps onto a
 * stable code in the shared error contract, so routes never invent responses.
 */
export class FinanceError extends ApiError {}

export const financeErrors = {
  validationFailed: (message: string, details?: Record<string, unknown>) =>
    new FinanceError("VALIDATION_FAILED", 400, message, false, details),
  authorityDenied: (message: string, details?: Record<string, unknown>) =>
    new FinanceError("AUTHORITY_DENIED", 403, message, false, details),
  policyDenied: (message: string, details?: Record<string, unknown>) =>
    new FinanceError("POLICY_DENIED", 403, message, false, details),
  notFound: (message: string) => new FinanceError("NOT_FOUND", 404, message, false),
  staleVersion: (message: string, details?: Record<string, unknown>) =>
    new FinanceError("STALE_VERSION", 409, message, false, details),
  idempotencyConflict: (message: string, details?: Record<string, unknown>) =>
    new FinanceError("IDEMPOTENCY_CONFLICT", 409, message, false, details),
  capacityExceeded: (message: string, details?: Record<string, unknown>) =>
    new FinanceError("CAPACITY_EXCEEDED", 409, message, false, details),
  dependencyUnavailable: (message: string) =>
    new FinanceError("DEPENDENCY_UNAVAILABLE", 503, message, true),
};
