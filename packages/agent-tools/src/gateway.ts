import {
  ToolExecutionContextSchema,
  ToolSchemas,
  type ToolExecutionContext,
  type ToolInput,
  type ToolName,
  type ToolResult,
} from "@alloc/contracts";
import { ZodError } from "zod";

export type ToolGatewayErrorCode =
  | "UNKNOWN_TOOL"
  | "INVALID_CONTEXT"
  | "TOOL_NOT_ALLOWED"
  | "LEASE_EXPIRED"
  | "SCOPE_DENIED"
  | "AUTHORITY_DENIED"
  | "INVALID_ARGUMENTS"
  | "INVALID_RESULT"
  | "ABORTED";

export class ToolGatewayError extends Error {
  constructor(readonly code: ToolGatewayErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolGatewayError";
  }
}

export interface ToolAuthorization {
  allowedTools: readonly ToolName[];
}

export type ToolAuthorizationResolver = (
  context: ToolExecutionContext,
) => Promise<ToolAuthorization> | ToolAuthorization;

export interface ToolHandler<Name extends ToolName> {
  authorize(
    context: ToolExecutionContext,
    input: ToolInput<Name>,
    signal: AbortSignal,
  ): Promise<boolean> | boolean;
  execute(
    context: ToolExecutionContext,
    input: ToolInput<Name>,
    signal: AbortSignal,
  ): Promise<ToolResult<Name>>;
}

export type ToolHandlers = {
  [Name in ToolName]?: ToolHandler<Name>;
};

export interface ToolInvocation<Name extends ToolName> {
  name: Name;
  modelArguments: unknown;
  executionContext: unknown;
  signal?: AbortSignal;
}

export interface ToolGatewayOptions {
  maxToolDurationMs: number;
  clock?: () => Date;
}

function scopeKey(scope: { type: string; id: string }): string {
  return `${scope.type}\u0000${scope.id}`;
}

function explicitScopes(name: ToolName, input: unknown): Array<{ type: string; id: string }> {
  if (name === "search_evidence") {
    return (input as ToolInput<"search_evidence">).scopes;
  }
  if (name === "run_forecast") {
    return [(input as ToolInput<"run_forecast">).scope];
  }
  return [];
}

function isToolName(value: string): value is ToolName {
  return Object.hasOwn(ToolSchemas, value);
}

export class ToolGateway {
  readonly #clock: () => Date;

  constructor(
    readonly handlers: ToolHandlers,
    readonly resolveAuthorization: ToolAuthorizationResolver,
    readonly options: ToolGatewayOptions,
  ) {
    if (!Number.isSafeInteger(options.maxToolDurationMs) || options.maxToolDurationMs < 1) {
      throw new RangeError("maxToolDurationMs must be a positive safe integer");
    }
    this.#clock = options.clock ?? (() => new Date());
  }

  async execute<Name extends ToolName>(invocation: ToolInvocation<Name>): Promise<ToolResult<Name>> {
    if (!isToolName(invocation.name)) {
      throw new ToolGatewayError("UNKNOWN_TOOL", `unknown tool: ${String(invocation.name)}`);
    }

    let context: ToolExecutionContext;
    try {
      context = ToolExecutionContextSchema.parse(invocation.executionContext);
    } catch (error) {
      throw new ToolGatewayError("INVALID_CONTEXT", "backend execution context is invalid", { cause: error });
    }

    const startedAt = this.#clock().getTime();
    const leaseExpiresAt = Date.parse(context.leaseExpiresAt);
    if (leaseExpiresAt <= startedAt) {
      throw new ToolGatewayError("LEASE_EXPIRED", "job lease has expired");
    }

    const authorization = await this.resolveAuthorization(context);
    if (!authorization.allowedTools.includes(invocation.name)) {
      throw new ToolGatewayError("TOOL_NOT_ALLOWED", "tool is not allowed for this job");
    }

    const contract = ToolSchemas[invocation.name] as unknown as {
      input: { parse(value: unknown): ToolInput<Name> };
      result: { parse(value: unknown): ToolResult<Name> };
    };
    let input: ToolInput<Name>;
    try {
      input = contract.input.parse(invocation.modelArguments);
    } catch (error) {
      throw new ToolGatewayError("INVALID_ARGUMENTS", "model tool arguments are invalid", { cause: error });
    }

    const allowedScopes = new Set(context.allowedScopes.map(scopeKey));
    if (explicitScopes(invocation.name, input).some((scope) => !allowedScopes.has(scopeKey(scope)))) {
      throw new ToolGatewayError("SCOPE_DENIED", "tool arguments request a scope outside the job grant");
    }

    const handler = this.handlers[invocation.name] as ToolHandler<Name> | undefined;
    if (handler === undefined) {
      throw new ToolGatewayError("TOOL_NOT_ALLOWED", "tool has no configured backend handler");
    }

    const controller = new AbortController();
    const remainingLeaseMs = leaseExpiresAt - startedAt;
    const timeoutMs = Math.min(this.options.maxToolDurationMs, remainingLeaseMs);
    const abortFromCaller = () => controller.abort(invocation.signal?.reason);
    if (invocation.signal?.aborted) abortFromCaller();
    invocation.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("tool execution deadline reached")),
      timeoutMs,
    );

    try {
      if (controller.signal.aborted) {
        throw new ToolGatewayError("ABORTED", "tool execution was canceled");
      }
      const authorized = await handler.authorize(context, input, controller.signal);
      if (!authorized) {
        throw new ToolGatewayError("AUTHORITY_DENIED", "backend authorization denied the tool call");
      }
      const rawResult = await handler.execute(context, input, controller.signal);
      if (controller.signal.aborted || Date.parse(context.leaseExpiresAt) <= this.#clock().getTime()) {
        throw new ToolGatewayError("ABORTED", "tool execution exceeded its bounded lease");
      }
      try {
        return contract.result.parse(rawResult);
      } catch (error) {
        if (error instanceof ZodError) {
          throw new ToolGatewayError("INVALID_RESULT", "backend tool result violated its contract", { cause: error });
        }
        throw error;
      }
    } finally {
      clearTimeout(timeout);
      invocation.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
