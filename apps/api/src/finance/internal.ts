import type { PurchaseRequestRevision, RecordRef, ScopeRef } from "@alloc/contracts";

/** One current request revision per request; denormalized for cumulative-limit queries. */
export interface RequestCurrentDocument {
  organizationId: string;
  requestId: string;
  currentRevision: number;
  evaluationState: PurchaseRequestRevision["evaluationState"];
  requesterId: string;
  purpose: string;
  projectId?: string;
  cumulativeIncrease: { amountMinor: number; currency: "USD" };
  updatedAt: string;
}

export interface PolicyGuardDocument {
  organizationId: string;
  policyId: string;
  activeRevision: number;
  authorizationEpoch: number;
  mutationCounter: number;
}

export interface PrincipalAuthorityDocument {
  organizationId: string;
  principalId: string;
  revision: number;
  roles: string[];
  scopes: ScopeRef[];
  revoked: boolean;
}

export interface PurposeDocument {
  organizationId: string;
  purpose: string;
  revision: number;
  active: boolean;
  ref?: RecordRef;
}

export interface CommandDocument {
  organizationId: string;
  commandId: string;
  fingerprint: string;
  operation: string;
  /** Absent until the owning transaction commits its result. */
  response?: Record<string, unknown>;
  correlationId: string;
  claimedAt: string;
  appliedAt?: string;
}

export interface AuditEventDocument {
  organizationId: string;
  auditEventId: string;
  type: string;
  subjectRef: RecordRef;
  requestId?: string;
  actorId: string;
  actorRoles: string[];
  commandId?: string;
  correlationId?: string;
  occurredAt: string;
  details?: Record<string, unknown>;
}

/** Authenticated caller, derived only from verified claims. */
export interface FinancialContext {
  readonly principalId: string;
  readonly organizationId: string;
  readonly roles: readonly string[];
}
