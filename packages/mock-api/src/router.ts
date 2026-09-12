import { CONTRACT_SCHEMA_VERSION, IdSchema, OperationSchemas } from "@alloc/contracts";
import type { OperationInput, OperationName } from "@alloc/contracts";
import { ZodError } from "zod";
import { canonicalJson } from "./canonical.js";
import { MockContractError, errorStatus, isErrorCode, isRetryable } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import type { MockStore } from "./store.js";

/** Used whenever the body never yielded a well-formed `meta.correlationId`. */
export const UNPARSED_CORRELATION_ID = "correlation_mock_unparsed";

export interface OperationReply {
  status: number;
  body: unknown;
}

export interface DispatchHeaders {
  principalId?: string;
  fault?: string;
}

type Meta = OperationInput<OperationName>["meta"];

function errorReply(code: ErrorCode, message: string, correlationId: string, details?: Record<string, unknown>): OperationReply {
  return {
    status: errorStatus(code),
    body: {
      ok: false,
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      correlationId,
      error: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        code,
        message,
        retryable: isRetryable(code),
        correlationId,
        ...(details === undefined ? {} : { details }),
      },
    },
  };
}

function correlationIdOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || !("meta" in value)) return undefined;
  const { meta } = value;
  if (meta === null || typeof meta !== "object" || !("correlationId" in meta)) return undefined;
  const candidate = meta.correlationId;
  return typeof candidate === "string" && IdSchema.safeParse(candidate).success ? candidate : undefined;
}

function commandIdOf(meta: Meta): string | undefined {
  return "commandId" in meta ? meta.commandId : undefined;
}

/**
 * Idempotency is central and applies to every operation whose meta is a command meta: a repeated
 * `commandId` with an equal payload replays the memoized data with the current correlation ID, a
 * repeated `commandId` with a different payload conflicts, and failed commands are not memoized.
 */
function runOperation(store: MockStore, operation: OperationName, parsed: unknown, headers: DispatchHeaders, correlationId: string): OperationReply {
  const inputResult = OperationSchemas[operation].input.safeParse(parsed);
  if (!inputResult.success) {
    return errorReply("VALIDATION_FAILED", `input does not satisfy ${operation}`, correlationId, { issues: inputResult.error.issues });
  }
  const input = inputResult.data;
  try {
    const principal = store.principalFor(input.meta.organizationId, headers.principalId);
    if (headers.fault !== undefined) {
      if (!isErrorCode(headers.fault)) {
        return errorReply("VALIDATION_FAILED", `unknown fault code ${headers.fault}`, correlationId, {
          reasonCode: "unknownFaultCode",
          fault: headers.fault,
        });
      }
      return errorReply(headers.fault, `Mock fault injection: ${headers.fault}`, correlationId, { injected: true, operation });
    }

    const payloadJson = canonicalJson(input.payload);
    const company = store.state(input.meta.organizationId);
    const commandId = commandIdOf(input.meta);
    if (commandId !== undefined) {
      const recorded = company.idempotency.get(commandId);
      if (recorded) {
        if (recorded.payloadJson !== payloadJson) {
          return errorReply("IDEMPOTENCY_CONFLICT", `command ${commandId} was already used with a different payload`, correlationId, { commandId });
        }
        return { status: 200, body: { ok: true, schemaVersion: CONTRACT_SCHEMA_VERSION, correlationId, data: recorded.data } };
      }
    }

    const data = store.execute(operation, input, principal);
    if (commandId !== undefined) company.idempotency.set(commandId, { payloadJson, data });
    return { status: 200, body: { ok: true, schemaVersion: CONTRACT_SCHEMA_VERSION, correlationId, data } };
  } catch (error) {
    if (error instanceof MockContractError) return errorReply(error.code, error.message, correlationId, error.details);
    if (error instanceof ZodError) {
      return errorReply("VALIDATION_FAILED", `payload does not satisfy ${operation}`, correlationId, { issues: error.issues });
    }
    return errorReply("INTERNAL_ERROR", "unexpected mock failure", correlationId, { operation });
  }
}

/** Every response leaves through the contract result schema, so the mock can never emit a body the frontend cannot parse. */
function finalize(operation: OperationName, reply: OperationReply): OperationReply {
  const parsed = OperationSchemas[operation].result.safeParse(reply.body);
  if (parsed.success) return { status: reply.status, body: parsed.data };
  const correlationId = correlationIdOf(reply.body) ?? UNPARSED_CORRELATION_ID;
  return errorReply("INTERNAL_ERROR", `mock produced a response that violates ${operation}`, correlationId, {
    issues: parsed.error.issues,
  });
}

export function dispatch(store: MockStore, operation: string, rawBody: string, headers: DispatchHeaders): OperationReply {
  if (!(operation in OperationSchemas)) {
    return errorReply("NOT_FOUND", `unknown operation ${operation}`, UNPARSED_CORRELATION_ID, { operation });
  }
  const name = operation as OperationName;
  let parsed: unknown;
  try {
    parsed = rawBody.trim() === "" ? {} : JSON.parse(rawBody);
  } catch {
    return errorReply("VALIDATION_FAILED", "request body is not valid JSON", UNPARSED_CORRELATION_ID, { reasonCode: "malformedJson" });
  }
  const correlationId = correlationIdOf(parsed) ?? UNPARSED_CORRELATION_ID;
  return finalize(name, runOperation(store, name, parsed, headers, correlationId));
}
