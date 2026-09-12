import {
  CONTRACT_SCHEMA_VERSION,
  type OperationInput,
  type OperationName,
  type OperationResult,
  type ToolExecutionContext,
} from "@alloc/contracts";
import type { ToolHandler, ToolHandlers } from "./gateway.js";

type SuccessfulResult<Name extends OperationName> = Extract<OperationResult<Name>, { ok: true }>;

export interface ContractOperationClient {
  expect<Name extends OperationName>(
    name: Name,
    input: OperationInput<Name>,
  ): Promise<SuccessfulResult<Name>>;
}

export interface ReadOperationAdapterOptions {
  createClient(context: ToolExecutionContext): ContractOperationClient;
  authorizeSubject(
    context: ToolExecutionContext,
    subject: { type: string; id: string },
    signal: AbortSignal,
  ): Promise<boolean> | boolean;
}

function correlationId(context: ToolExecutionContext, suffix: string): string {
  return `correlation_${context.jobId}_${context.leaseGeneration}_${suffix}`;
}

function queryMeta(context: ToolExecutionContext, suffix: string) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: context.organizationId,
    correlationId: correlationId(context, suffix),
  } as const;
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("tool call aborted");
}

export function createReadOperationToolHandlers(options: ReadOperationAdapterOptions): ToolHandlers {
  const getRequest: ToolHandler<"get_request"> = {
    authorize: (context, input, signal) => options.authorizeSubject(
      context,
      { type: "request", id: input.requestId },
      signal,
    ),
    async execute(context, input, signal) {
      ensureActive(signal);
      const response = await options.createClient(context).expect("requests.get", {
        meta: queryMeta(context, "get_request"),
        payload: { requestId: input.requestId },
      });
      ensureActive(signal);
      return { request: response.data.request, current: true };
    },
  };

  const searchEvidence: ToolHandler<"search_evidence"> = {
    authorize: () => true,
    async execute(context, input, signal) {
      ensureActive(signal);
      const response = await options.createClient(context).expect("memory.query", {
        meta: queryMeta(context, "search_evidence"),
        payload: { query: input.query, scopes: input.scopes, page: input.page },
      });
      ensureActive(signal);
      const requestedKinds = new Set(input.kinds);
      return {
        evidence: response.data.evidence.filter(({ kind }) => requestedKinds.has(kind)).slice(0, 8),
        truncated: response.data.page.truncated || response.data.evidence.length > 8,
        continuation: response.data.page.nextCursor,
      };
    },
  };

  return { get_request: getRequest, search_evidence: searchEvidence };
}
