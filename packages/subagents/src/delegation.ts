import {
  ChildDelegationRequestSchema,
  ChildRolePolicySchema,
  ChildTaskSchema,
  ParentDelegationAuthoritySchema,
  type ChildDelegationRequest,
  type ChildRolePolicy,
  type ChildTask,
  type ParentDelegationAuthority,
} from "./schemas.js";

export type DelegationErrorCode =
  | "PARENT_LEASE_EXPIRED"
  | "RECURSIVE_DELEGATION_DENIED"
  | "CHILD_LIMIT_REACHED"
  | "ROLE_MISMATCH"
  | "NO_AUTHORIZED_SCOPE"
  | "NO_AUTHORIZED_TOOL"
  | "INVALID_EXPIRY";

export class DelegationError extends Error {
  constructor(readonly code: DelegationErrorCode, message: string) {
    super(message);
    this.name = "DelegationError";
  }
}

export interface IssuedChildIdentity {
  childTaskId: string;
  childServiceIdentityId: string;
}

export interface AdmissionResult {
  task: ChildTask;
  deniedScopes: ChildDelegationRequest["requestedScopes"];
  deniedTools: ChildDelegationRequest["requestedTools"];
}

export const CHILD_READ_ONLY_TOOLS = [
  "get_request",
  "get_context",
  "search_evidence",
  "run_forecast",
] as const satisfies readonly ChildTask["permittedTools"][number][];

function scopeKey(scope: { type: string; id: string }): string {
  return `${scope.type}\u0000${scope.id}`;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const itemKey = key(value);
    if (seen.has(itemKey)) return false;
    seen.add(itemKey);
    return true;
  });
}

function lessUrgentPriority(
  parent: ParentDelegationAuthority["priority"],
  roleMaximum: ChildRolePolicy["maximumPriority"],
): ChildTask["priority"] {
  const rank = { P0: 0, P1: 1, P2: 2 } as const;
  return rank[parent] >= rank[roleMaximum] ? parent : roleMaximum;
}

export function admitChildTask(input: {
  parent: ParentDelegationAuthority;
  rolePolicy: ChildRolePolicy;
  request: ChildDelegationRequest;
  identity: IssuedChildIdentity;
  activeChildTaskIds: readonly string[];
  now: Date;
}): AdmissionResult {
  const parent = ParentDelegationAuthoritySchema.parse(input.parent);
  const rolePolicy = ChildRolePolicySchema.parse(input.rolePolicy);
  const request = ChildDelegationRequestSchema.parse(input.request);
  const nowMs = input.now.getTime();
  if (Date.parse(parent.leaseExpiresAt) <= nowMs) {
    throw new DelegationError("PARENT_LEASE_EXPIRED", "parent lease has expired");
  }
  if (parent.delegationDepth !== 0) {
    throw new DelegationError("RECURSIVE_DELEGATION_DENIED", "child tasks cannot delegate");
  }
  if (new Set(input.activeChildTaskIds).size >= 2) {
    throw new DelegationError("CHILD_LIMIT_REACHED", "a parent may have at most two active children");
  }
  if (rolePolicy.role !== request.role) {
    throw new DelegationError("ROLE_MISMATCH", "requested child role does not match its policy");
  }

  const parentScopes = new Set(parent.allowedScopes.map(scopeKey));
  const roleScopes = new Set(rolePolicy.allowedScopes.map(scopeKey));
  const requestedScopes = uniqueBy(request.requestedScopes, scopeKey);
  const allowedScopes = requestedScopes.filter(
    (scope) => parentScopes.has(scopeKey(scope)) && roleScopes.has(scopeKey(scope)),
  );
  const deniedScopes = requestedScopes.filter(
    (scope) => !allowedScopes.some((allowed) => scopeKey(allowed) === scopeKey(scope)),
  );
  if (allowedScopes.length === 0) {
    throw new DelegationError("NO_AUTHORIZED_SCOPE", "no requested scope survives authority intersection");
  }

  const parentTools = new Set(parent.permittedTools);
  const roleTools = new Set(rolePolicy.permittedTools);
  const childReadOnlyTools = new Set<ChildTask["permittedTools"][number]>(CHILD_READ_ONLY_TOOLS);
  const requestedTools = [...new Set(request.requestedTools)];
  const permittedTools = requestedTools.filter(
    (tool) => parentTools.has(tool) && roleTools.has(tool) && childReadOnlyTools.has(tool),
  );
  const deniedTools = requestedTools.filter((tool) => !permittedTools.includes(tool));
  if (requestedTools.length > 0 && permittedTools.length === 0) {
    throw new DelegationError("NO_AUTHORIZED_TOOL", "no requested tool survives authority intersection");
  }

  const maximumRoleExpiry = nowMs + rolePolicy.maximumLifetimeMs;
  const expiresAtMs = Math.min(
    Date.parse(request.requestedExpiresAt),
    Date.parse(parent.leaseExpiresAt),
    maximumRoleExpiry,
  );
  if (expiresAtMs <= nowMs) {
    throw new DelegationError("INVALID_EXPIRY", "child expiry must be in the future");
  }

  const task = ChildTaskSchema.parse({
    schemaVersion: parent.schemaVersion,
    organizationId: parent.organizationId,
    childTaskId: input.identity.childTaskId,
    parentJobId: parent.parentJobId,
    parentLeaseGeneration: parent.leaseGeneration,
    childServiceIdentityId: input.identity.childServiceIdentityId,
    role: request.role,
    delegationDepth: 1,
    objective: request.objective,
    priority: lessUrgentPriority(parent.priority, rolePolicy.maximumPriority),
    allowedScopes,
    permittedTools,
    admittedAt: input.now.toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    evidenceCutoff: parent.evidenceCutoff,
    toolCallBudget: Math.min(request.requestedToolCalls, rolePolicy.maximumToolCalls),
    outputByteBudget: Math.min(request.requestedOutputBytes, rolePolicy.maximumOutputBytes),
    contextTokenBudget: Math.min(request.requestedContextTokens, rolePolicy.maximumContextTokens),
  });
  return { task, deniedScopes, deniedTools };
}
