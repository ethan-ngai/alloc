import { CONTRACT_SCHEMA_VERSION } from "@alloc/contracts";
import type { SourceDelivery } from "../contract-types.js";
import type { RecordRef } from "../contract-types.js";
import { appendActivity, sourceSummary } from "./context.js";
import type { Handler } from "./context.js";

const SIMULATED_EVENT_TYPES: readonly string[] = ["expense_recorded", "usage_recorded", "invoice_recorded"];

/**
 * Source ingestion with deduplication on `sourceInstanceId|sourceObjectId|sourceRevision`. Accepted
 * deliveries also record a normalized ref; quarantined deliveries keep their delivery ref and no
 * normalized refs. A replayed delivery (accepted or quarantined) reports `duplicate` and reuses the
 * original refs.
 */
export const ingestSource: Handler<"imports.ingest"> = (ctx, payload) => {
  const dedupKey = `${payload.sourceInstanceId}|${payload.sourceObjectId}|${payload.sourceRevision}`;
  const seen = ctx.company.ingestLedger.get(dedupKey);
  if (seen) {
    return { deliveryRef: seen.deliveryRef, disposition: "duplicate", normalizedRefs: seen.normalizedRefs };
  }

  const deliveryRef: RecordRef = { type: "source_delivery", id: ctx.ids.next("delivery"), revision: 1 };
  const delivery: SourceDelivery = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: ctx.company.organizationId,
    sourceInstanceId: payload.sourceInstanceId,
    deliveryId: payload.deliveryId,
    sourceObjectId: payload.sourceObjectId,
    sourceRevision: payload.sourceRevision,
    eventType: payload.eventType,
    occurredAt: payload.occurredAt,
    observedAt: payload.observedAt,
    isSynthetic: payload.isSynthetic,
    provenance: structuredClone(payload.provenance),
    payload: structuredClone(payload.payload),
  };
  ctx.company.deliveries.push(delivery);

  if (!SIMULATED_EVENT_TYPES.includes(payload.eventType)) {
    ctx.company.ingestLedger.set(dedupKey, { deliveryRef, normalizedRefs: [] });
    return { deliveryRef, disposition: "quarantined", normalizedRefs: [] };
  }

  const normalizedRefs: RecordRef[] = [{ type: "normalized_record", id: ctx.ids.next("normalized"), revision: 1 }];
  ctx.company.ingestLedger.set(dedupKey, { deliveryRef, normalizedRefs });
  // A source delivery carries no scopes of its own, so its activity is recorded against the
  // organization and its operating department.
  appendActivity(ctx, {
    activityId: ctx.ids.next("activity"),
    type: "source",
    occurredAt: delivery.occurredAt,
    subjectRef: deliveryRef,
    summary: sourceSummary(deliveryRef.id, "accepted"),
  }, ctx.company.registry.scopeRefs.slice(0, 2));
  return { deliveryRef, disposition: "accepted", normalizedRefs };
};
