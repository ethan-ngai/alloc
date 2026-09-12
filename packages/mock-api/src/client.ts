import { IdSchema, OperationSchemas } from "@alloc/contracts";
import type { OperationInput, OperationName, OperationResult } from "@alloc/contracts";
import type { z } from "zod";
import { isRetryable } from "./errors.js";
import type { ErrorCode } from "./errors.js";

/** Headers the mock server understands. Browser-safe: no `node:*` import lives in this module. */
export const MOCK_PRINCIPAL_HEADER = "x-alloc-mock-principal";
export const MOCK_FAULT_HEADER = "x-alloc-mock-fault";
export const DEFAULT_TIMEOUT_MS = 10_000;

const INVALID_BODY_CORRELATION_ID = "correlation_client_invalid_body";

export function operationPath(name: OperationName): string {
  return `/operations/${name}`;
}

export interface ContractClientOptions {
  baseUrl: string;
  principalId?: string;
  fault?: ErrorCode;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ContractClientErrorOptions {
  code: ErrorCode;
  status: number;
  correlationId: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export class ContractClientError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly correlationId: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: ContractClientErrorOptions) {
    super(message);
    this.name = "ContractClientError";
    this.code = options.code;
    this.retryable = options.retryable ?? isRetryable(options.code);
    this.status = options.status;
    this.correlationId = options.correlationId;
    if (options.details !== undefined) this.details = options.details;
  }
}

export interface ContractClient {
  call<Name extends OperationName>(name: Name, input: OperationInput<Name>): Promise<OperationResult<Name>>;
  expect<Name extends OperationName>(name: Name, input: OperationInput<Name>): Promise<Extract<OperationResult<Name>, { ok: true }>>;
}

function correlationIdOf(body: unknown): string {
  if (body === null || typeof body !== "object" || !("correlationId" in body)) return INVALID_BODY_CORRELATION_ID;
  const candidate = body.correlationId;
  return typeof candidate === "string" && IdSchema.safeParse(candidate).success ? candidate : INVALID_BODY_CORRELATION_ID;
}

/**
 * Typed client over the mock's HTTP surface. `call` returns the contract result union unchanged;
 * `expect` throws `ContractClientError` when the mock answers `ok: false`. Bodies are parsed with
 * the 1A result schema, so a mock that drifts from the contract fails loudly in the client too.
 */
export function createContractClient(options: ContractClientOptions): ContractClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const send = async (name: OperationName, input: unknown): Promise<{ status: number; body: unknown }> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.principalId !== undefined) headers[MOCK_PRINCIPAL_HEADER] = options.principalId;
    if (options.fault !== undefined) headers[MOCK_FAULT_HEADER] = options.fault;

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${operationPath(name)}`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ContractClientError(`${baseUrl} is unreachable: ${reason}`, {
        code: "DEPENDENCY_UNAVAILABLE",
        status: 0,
        correlationId: INVALID_BODY_CORRELATION_ID,
        retryable: true,
      });
    }

    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      throw new ContractClientError(`${baseUrl} returned a non-JSON body for ${name}`, {
        code: "INTERNAL_ERROR",
        status: response.status,
        correlationId: INVALID_BODY_CORRELATION_ID,
        details: { issues: [{ code: "invalid_json", message: "response body is not JSON" }] },
      });
    }
  };

  const callWithStatus = async <Name extends OperationName>(
    name: Name,
    input: OperationInput<Name>,
  ): Promise<{ result: OperationResult<Name>; status: number }> => {
    const response = await send(name, input);
    const schema = OperationSchemas[name].result as unknown as z.ZodType<unknown>;
    const parsed = schema.safeParse(response.body);
    if (!parsed.success) {
      throw new ContractClientError(`${baseUrl} returned a body that violates ${name}`, {
        code: "INTERNAL_ERROR",
        status: response.status,
        correlationId: correlationIdOf(response.body),
        details: { issues: parsed.error.issues },
      });
    }
    return { result: parsed.data as OperationResult<Name>, status: response.status };
  };

  return {
    async call<Name extends OperationName>(name: Name, input: OperationInput<Name>): Promise<OperationResult<Name>> {
      return (await callWithStatus(name, input)).result;
    },
    async expect<Name extends OperationName>(name: Name, input: OperationInput<Name>): Promise<Extract<OperationResult<Name>, { ok: true }>> {
      const { result, status } = await callWithStatus(name, input);
      if (!result.ok) {
        throw new ContractClientError(result.error.message, {
          code: result.error.code,
          retryable: result.error.retryable,
          status,
          correlationId: result.error.correlationId,
          ...(result.error.details === undefined ? {} : { details: result.error.details }),
        });
      }
      // TypeScript cannot distribute `Extract` over an unresolved `Name`, so the narrowed union is asserted here.
      return result as Extract<OperationResult<Name>, { ok: true }>;
    },
  };
}
