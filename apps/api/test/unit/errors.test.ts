import { operationResult } from "@alloc/contracts";
import { MongoNetworkError } from "mongodb";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError, apiErrors, errorEnvelope, toApiError } from "../../src/errors.js";

const AnyResultSchema = operationResult(z.unknown());

describe("toApiError", () => {
  it("passes through errors that already carry an error contract code", () => {
    const error = apiErrors.forbidden();
    expect(toApiError(error)).toBe(error);
  });

  it("maps framework status codes onto contract codes", () => {
    expect(toApiError(Object.assign(new Error("bad body"), { statusCode: 400 }))).toMatchObject({
      code: "VALIDATION_FAILED",
      statusCode: 400,
    });
    expect(toApiError(Object.assign(new Error("no token"), { statusCode: 401 }))).toMatchObject({
      code: "ACCESS_DENIED",
      statusCode: 401,
    });
    expect(toApiError(Object.assign(new Error("missing"), { statusCode: 404 }))).toMatchObject({
      code: "NOT_FOUND",
      statusCode: 404,
    });
    expect(toApiError(Object.assign(new Error("down"), { statusCode: 503 }))).toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      statusCode: 503,
      retryable: true,
    });
  });

  it("maps database failures to a retryable dependency error without driver detail", () => {
    const error = new MongoNetworkError("connection to 127.0.0.1:27017 refused");
    const mapped = toApiError(error);

    expect(mapped).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", statusCode: 503, retryable: true });
    expect(mapped.message).not.toContain("127.0.0.1:27017");
  });

  it("maps unexpected failures to a generic internal error", () => {
    const mapped = toApiError(new Error("secret internal detail"));

    expect(mapped).toMatchObject({ code: "INTERNAL_ERROR", statusCode: 500, message: "Internal server error" });
    expect(mapped.message).not.toContain("secret internal detail");
  });
});

describe("errorEnvelope", () => {
  it("conforms to the shared operation-result contract", () => {
    const envelope = errorEnvelope("corr_abc123", apiErrors.notFound("Organization not found"));
    const parsed = AnyResultSchema.parse(envelope);

    expect(parsed).toEqual({
      ok: false,
      schemaVersion: "1.0.0",
      correlationId: "corr_abc123",
      error: {
        schemaVersion: "1.0.0",
        code: "NOT_FOUND",
        message: "Organization not found",
        retryable: false,
        correlationId: "corr_abc123",
      },
    });
  });

  it("carries optional details when supplied", () => {
    const envelope = errorEnvelope(
      "corr_abc123",
      new ApiError("VALIDATION_FAILED", 400, "Request validation failed", false, { field: "organizationId" }),
    );

    expect(AnyResultSchema.parse(envelope)).toMatchObject({ error: { details: { field: "organizationId" } } });
  });
});
