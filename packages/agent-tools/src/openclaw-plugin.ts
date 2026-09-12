import { ToolSchemas, type ToolExecutionContext, type ToolName } from "@alloc/contracts";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import { ToolGateway } from "./gateway.js";

/** Namespace under which the Alloc worker attaches job identity to an OpenClaw run. */
export const ALLOC_BINDING_KEY = "alloc";

const BindingSchema = z.strictObject({
  jobId: z.string().min(1),
  leaseGeneration: z.number().int().nonnegative(),
});

export type AllocToolBinding = z.infer<typeof BindingSchema>;

export type ExecutionContextResolver = (
  binding: AllocToolBinding,
  signal?: AbortSignal,
) => Promise<ToolExecutionContext>;

export interface AllocToolPluginOptions {
  gateway: ToolGateway;
  /**
   * Returns the job's current authority. The binding only identifies the job, so
   * a renewed or revoked lease is observed at call time rather than frozen into
   * the run when it started.
   */
  resolveExecutionContext: ExecutionContextResolver;
  /** Tools this deployment exposes; the backend allowlist is still authoritative. */
  tools: readonly ToolName[];
}

const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  get_request: "Read the current revision of one purchase request by ID.",
  get_context: "Read authorized financial context for a scope.",
  search_evidence: "Search authorized evidence within granted scopes.",
  run_forecast: "Run a deterministic forecast for one authorized scope.",
  propose_action: "Submit a proposed financial action for backend review.",
};

/** Wraps a contract input schema as a TypeBox schema for the model-facing tool. */
function parametersFor(name: ToolName): TSchema {
  const jsonSchema = z.toJSONSchema(ToolSchemas[name].input, {
    target: "draft-2020-12",
    io: "input",
  });
  return Type.Unsafe<unknown>(jsonSchema);
}

/**
 * Reads job identity from the trusted run context. `toolBindings` is attached by
 * the run initiator, so a model cannot reach it by writing tool arguments.
 */
export function readBinding(toolContext: {
  toolBindings?: Readonly<Record<string, unknown>>;
}): AllocToolBinding | null {
  const candidate = toolContext.toolBindings?.[ALLOC_BINDING_KEY];
  const parsed = BindingSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Builds one tool declaration. A run without an Alloc binding gets no tool at all
 * rather than a default identity, so an unbound agent cannot reach the backend.
 */
export function allocToolDefinition(name: ToolName, options: AllocToolPluginOptions) {
  const shape = {
    name,
    label: name,
    description: TOOL_DESCRIPTIONS[name],
    parameters: parametersFor(name),
  };
  return {
    ...shape,
    factory: ({ toolContext }: { toolContext: { toolBindings?: Readonly<Record<string, unknown>> } }) => {
      const binding = readBinding(toolContext);
      if (binding === null) return null;
      return {
        ...shape,
        // Evidence and request text originate outside the model's trust boundary.
        resultContentSource: "network" as const,
        async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
          const executionContext = await options.resolveExecutionContext(binding, signal);
          const details = await options.gateway.execute({
            name,
            modelArguments: params,
            executionContext,
            ...(signal === undefined ? {} : { signal }),
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(details) }],
            details,
          };
        },
      };
    },
  };
}

/**
 * Exposes Alloc's contract tools to a local OpenClaw agent.
 *
 * The plugin carries no authority of its own: it forwards model arguments and a
 * backend-resolved execution context to the gateway, which re-checks the
 * allowlist, scopes, lease, and both schemas.
 */
export function createAllocToolPlugin(options: AllocToolPluginOptions) {
  const exposed = [...new Set(options.tools)];
  return defineToolPlugin({
    id: "alloc-financial-tools",
    name: "Alloc financial tools",
    description: "Scoped, backend-authorized financial reads and proposals for Alloc.",
    tools: (tool) => exposed.map((name) => tool(allocToolDefinition(name, options) as never)),
  });
}
