import { CONTRACT_SCHEMA_VERSION, type RecordRef } from "@alloc/contracts";
import type { ClientSession, Db } from "mongodb";
import { AUDIT_EVENTS_COLLECTION } from "./collections.js";
import { recordId } from "./ids.js";

export interface AuditEventInput {
  type: string;
  subjectRef: RecordRef;
  requestId?: string;
  actorId: string;
  actorRoles: readonly string[];
  commandId?: string;
  correlationId?: string;
  occurredAt: string;
  details?: Record<string, unknown>;
}

/**
 * Appends immutable audit events inside the caller's transaction. IDs are
 * deterministic from the command and position so a retried transaction cannot
 * duplicate an event beyond its own rollback.
 */
export async function appendAuditEvents(
  db: Db,
  organizationId: string,
  seed: string,
  events: readonly AuditEventInput[],
  session: ClientSession,
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  await db.collection(AUDIT_EVENTS_COLLECTION).insertMany(
    events.map((event, index) => ({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      organizationId,
      auditEventId: recordId("audit", organizationId, seed, index, event.type),
      ...event,
      actorRoles: [...event.actorRoles],
    })),
    { session },
  );
}
