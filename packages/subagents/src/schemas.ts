import { z } from "zod";
import {
  ContractSchemaVersionSchema,
  IdSchema,
  OrganizationIdSchema,
  PrioritySchema,
  RecordRefSchema,
  RevisionSchema,
  ScopeRefSchema,
  TimestampSchema,
  ToolSchemas,
} from "@alloc/contracts";

const ToolNameSchema = z.enum(Object.keys(ToolSchemas) as [keyof typeof ToolSchemas, ...(keyof typeof ToolSchemas)[]]);

export const ChildRoleSchema = z.enum(["project_investigator", "spending_analyst"]);

export const ParentDelegationAuthoritySchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  parentJobId: IdSchema,
  parentServiceIdentityId: IdSchema,
  leaseGeneration: RevisionSchema,
  leaseExpiresAt: TimestampSchema,
  delegationDepth: z.union([z.literal(0), z.literal(1)]),
  priority: PrioritySchema,
  allowedScopes: z.array(ScopeRefSchema).min(1).max(50),
  permittedTools: z.array(ToolNameSchema).max(5),
  evidenceCutoff: TimestampSchema,
});

export const ChildRolePolicySchema = z.strictObject({
  role: ChildRoleSchema,
  maximumPriority: PrioritySchema,
  allowedScopes: z.array(ScopeRefSchema).min(1).max(50),
  permittedTools: z.array(ToolNameSchema).max(5),
  maximumLifetimeMs: z.number().int().safe().min(1).max(30 * 60_000),
  maximumToolCalls: z.number().int().safe().min(1).max(50),
  maximumOutputBytes: z.number().int().safe().min(256).max(1_000_000),
  maximumContextTokens: z.number().int().safe().min(256).max(128_000),
});

export const ChildDelegationRequestSchema = z.strictObject({
  role: ChildRoleSchema,
  objective: z.string().min(1).max(2_000),
  requestedScopes: z.array(ScopeRefSchema).min(1).max(50),
  requestedTools: z.array(ToolNameSchema).max(5),
  requestedExpiresAt: TimestampSchema,
  requestedToolCalls: z.number().int().safe().min(1).max(50),
  requestedOutputBytes: z.number().int().safe().min(256).max(1_000_000),
  requestedContextTokens: z.number().int().safe().min(256).max(128_000),
});

export const ChildTaskSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  childTaskId: IdSchema,
  parentJobId: IdSchema,
  parentLeaseGeneration: RevisionSchema,
  childServiceIdentityId: IdSchema,
  role: ChildRoleSchema,
  delegationDepth: z.literal(1),
  objective: z.string().min(1).max(2_000),
  priority: PrioritySchema,
  allowedScopes: z.array(ScopeRefSchema).min(1).max(50),
  permittedTools: z.array(ToolNameSchema).max(5),
  admittedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  evidenceCutoff: TimestampSchema,
  toolCallBudget: z.number().int().safe().min(1).max(50),
  outputByteBudget: z.number().int().safe().min(256).max(1_000_000),
  contextTokenBudget: z.number().int().safe().min(256).max(128_000),
});

export const ChildLifecycleStateSchema = z.enum([
  "admitted",
  "running",
  "completed",
  "failed",
  "canceled",
  "detached",
]);

export const ChildRuntimeRecordSchema = z.strictObject({
  task: ChildTaskSchema,
  state: ChildLifecycleStateSchema,
  toolCallsUsed: z.number().int().safe().nonnegative(),
  detachedAt: TimestampSchema.nullable(),
  terminatedAt: TimestampSchema.nullable(),
}).superRefine(({ task, state, toolCallsUsed, detachedAt, terminatedAt }, context) => {
  if (toolCallsUsed > task.toolCallBudget) {
    context.addIssue({ code: "custom", message: "tool calls exceed the admitted budget", path: ["toolCallsUsed"] });
  }
  if (state === "detached" && detachedAt === null) {
    context.addIssue({ code: "custom", message: "detached children require detachedAt", path: ["detachedAt"] });
  }
  if ((state === "admitted" || state === "running") && detachedAt !== null) {
    context.addIssue({ code: "custom", message: "active attached children cannot have detachedAt", path: ["detachedAt"] });
  }
  const terminal = state === "completed" || state === "failed" || state === "canceled";
  if (terminal !== (terminatedAt !== null)) {
    context.addIssue({ code: "custom", message: "terminal children require terminatedAt", path: ["terminatedAt"] });
  }
});

export const ChildClaimSchema = z.strictObject({
  claimKey: z.string().min(1).max(200),
  value: z.string().min(1).max(2_000),
  statement: z.string().min(1).max(4_000),
  evidenceRefs: z.array(RecordRefSchema.extend({ revision: RevisionSchema })).max(20),
  calculatedResultRefs: z.array(RecordRefSchema.extend({ revision: RevisionSchema })).max(20),
}).refine(
  ({ evidenceRefs, calculatedResultRefs }) => evidenceRefs.length + calculatedResultRefs.length > 0,
  { message: "each claim requires versioned evidence or a calculated result" },
);

export const ChildResultSchema = z.strictObject({
  schemaVersion: ContractSchemaVersionSchema,
  organizationId: OrganizationIdSchema,
  childTaskId: IdSchema,
  parentJobId: IdSchema,
  parentLeaseGeneration: RevisionSchema,
  completion: z.enum(["completed", "partial", "failed", "canceled"]),
  claims: z.array(ChildClaimSchema).max(20),
  missingContext: z.array(z.string().min(1).max(500)).max(20),
  coverage: z.strictObject({
    inspectedRecords: z.number().int().safe().nonnegative(),
    truncated: z.boolean(),
  }),
  completedAt: TimestampSchema,
}).superRefine(({ completion, claims }, context) => {
  if ((completion === "failed" || completion === "canceled") && claims.length > 0) {
    context.addIssue({
      code: "custom",
      message: "failed or canceled child results cannot contain claims",
      path: ["claims"],
    });
  }
});

export type ChildRole = z.infer<typeof ChildRoleSchema>;
export type ParentDelegationAuthority = z.infer<typeof ParentDelegationAuthoritySchema>;
export type ChildRolePolicy = z.infer<typeof ChildRolePolicySchema>;
export type ChildDelegationRequest = z.infer<typeof ChildDelegationRequestSchema>;
export type ChildTask = z.infer<typeof ChildTaskSchema>;
export type ChildLifecycleState = z.infer<typeof ChildLifecycleStateSchema>;
export type ChildRuntimeRecord = z.infer<typeof ChildRuntimeRecordSchema>;
export type ChildResult = z.infer<typeof ChildResultSchema>;
export type ChildClaim = z.infer<typeof ChildClaimSchema>;
