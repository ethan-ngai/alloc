import { createHash } from "node:crypto";
import { CompanyEntitySchema, PostingSchema, SourceDeliverySchema, type CompanyEntity, type Posting, type SourceDelivery } from "@alloc/contracts";
import type { ClientSession, Db } from "mongodb";

export const SOURCE_DELIVERIES_COLLECTION = "source_deliveries";
export const NORMALIZED_POSTINGS_COLLECTION = "normalized_postings";
export const IMPORT_ENTITIES_COLLECTION = "import_entities";
export const ENTITY_MAPPINGS_COLLECTION = "entity_mappings";

export interface IngestResult {
  readonly deliveryRef: { type: string; id: string; revision: number };
  readonly disposition: "accepted" | "duplicate" | "quarantined";
  readonly normalizedRefs: Array<{ type: string; id: string; revision: number }>;
}

export class SourceConflictError extends Error {
  override readonly name = "SourceConflictError";
}

export interface ImportRepository {
  ingest(delivery: SourceDelivery): Promise<IngestResult>;
  listPostings(organizationId: string): Promise<Posting[]>;
  seedEntities(entities: readonly CompanyEntity[]): Promise<void>;
  seedMappings(mappings: readonly { sourceInstanceId: string; sourceObjectId: string; entityId: string; organizationId?: string }[]): Promise<void>;
}

/** Creates the small, append-only import ledger. Financial projections are deliberately not updated here: 3B owns them. */
export async function ensureImportCollections(db: Db): Promise<void> {
  await Promise.all([
    db.collection(SOURCE_DELIVERIES_COLLECTION).createIndexes([
      { key: { organizationId: 1, sourceInstanceId: 1, deliveryId: 1 }, name: "delivery_identity", unique: true },
      { key: { organizationId: 1, sourceInstanceId: 1, sourceObjectId: 1, sourceRevision: 1 }, name: "source_revision", unique: true },
    ]),
    db.collection(NORMALIZED_POSTINGS_COLLECTION).createIndexes([
      { key: { organizationId: 1, postingId: 1, revision: 1 }, name: "posting_identity", unique: true },
    ]),
    db.collection(IMPORT_ENTITIES_COLLECTION).createIndexes([
      { key: { organizationId: 1, entityId: 1 }, name: "entity_identity", unique: true },
    ]),
    db.collection(ENTITY_MAPPINGS_COLLECTION).createIndexes([
      { key: { organizationId: 1, sourceInstanceId: 1, sourceObjectId: 1 }, name: "mapping_identity", unique: true },
    ]),
  ]);
}

export class MongoImportRepository implements ImportRepository {
  constructor(private readonly db: Db, private readonly withTransaction: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>) {}

  async ingest(candidate: SourceDelivery): Promise<IngestResult> {
    const delivery = SourceDeliverySchema.parse(candidate);
    return this.withTransaction(async (session) => {
      const deliveries = this.db.collection(SOURCE_DELIVERIES_COLLECTION);
      const existingDelivery = await deliveries.findOne({ organizationId: delivery.organizationId, sourceInstanceId: delivery.sourceInstanceId, deliveryId: delivery.deliveryId }, { session });
      if (existingDelivery) {
        if (existingDelivery.transportHash !== hash(delivery)) throw new SourceConflictError("deliveryId was reused with a different payload");
        return { ...(existingDelivery.result as IngestResult), disposition: "duplicate" };
      }
      const existingRevision = await deliveries.findOne({ organizationId: delivery.organizationId, sourceInstanceId: delivery.sourceInstanceId, sourceObjectId: delivery.sourceObjectId, sourceRevision: delivery.sourceRevision }, { session });
      if (existingRevision) {
        if (existingRevision.sourceHash !== sourceHash(delivery)) throw new SourceConflictError("source revision was reused with different content");
        return { ...existingRevision.result, disposition: "duplicate" } as IngestResult;
      }

      const deliveryRef = { type: "source_delivery", id: `delivery_${hash([delivery.organizationId, delivery.sourceInstanceId, delivery.deliveryId]).slice(0, 20)}`, revision: 1 };
      const stale = await this.isStale(delivery, session);
      const posting = delivery.eventType === "fixture.expense" ? PostingSchema.safeParse(delivery.payload.posting) : null;
      const mapped = await this.mappedEntity(delivery, session);
      const accepted = !stale && (posting?.success ? await this.postingScopesExist(delivery.organizationId, posting.data, session) : mapped !== null);
      const result: IngestResult = posting?.success && accepted
        ? { deliveryRef, disposition: "accepted", normalizedRefs: [{ type: "posting", id: posting.data.postingId, revision: posting.data.revision }] }
        : mapped && accepted ? { deliveryRef, disposition: "accepted", normalizedRefs: [{ type: "entity", id: mapped.entityId, revision: mapped.revision }] }
        : { deliveryRef, disposition: "quarantined", normalizedRefs: [] };

      await deliveries.insertOne({ ...delivery, deliveryRef, transportHash: hash(delivery), sourceHash: sourceHash(delivery), result }, { session });
      if (posting?.success && accepted) {
        await this.db.collection(NORMALIZED_POSTINGS_COLLECTION).updateMany(
          { organizationId: delivery.organizationId, sourceInstanceId: delivery.sourceInstanceId, sourceObjectId: delivery.sourceObjectId, current: true },
          { $set: { current: false } },
          { session },
        );
        await this.db.collection(NORMALIZED_POSTINGS_COLLECTION).insertOne({ ...posting.data, deliveryRef, sourceInstanceId: delivery.sourceInstanceId, sourceObjectId: delivery.sourceObjectId, sourceRevision: delivery.sourceRevision, current: true }, { session });
      }
      return result;
    });
  }

  async listPostings(organizationId: string): Promise<Posting[]> {
    return (await this.db.collection(NORMALIZED_POSTINGS_COLLECTION).find({ organizationId, current: true }, { projection: { _id: 0, deliveryRef: 0, sourceInstanceId: 0, sourceObjectId: 0, sourceRevision: 0, current: 0 } }).toArray()).map((record) => PostingSchema.parse(record));
  }

  async seedEntities(entities: readonly CompanyEntity[]): Promise<void> {
    if (!entities.length) return;
    await this.db.collection(IMPORT_ENTITIES_COLLECTION).bulkWrite(entities.map((entity) => {
      const parsed = CompanyEntitySchema.parse(entity);
      return { replaceOne: { filter: { organizationId: parsed.organizationId, entityId: parsed.entityId }, replacement: parsed, upsert: true } };
    }));
  }

  async seedMappings(mappings: readonly { sourceInstanceId: string; sourceObjectId: string; entityId: string; organizationId?: string }[]): Promise<void> {
    if (!mappings.length) return;
    const resolved = await Promise.all(mappings.map(async (mapping) => {
      const entity = mapping.organizationId ? null : await this.db.collection(IMPORT_ENTITIES_COLLECTION).findOne({ entityId: mapping.entityId }, { projection: { _id: 0, organizationId: 1 } });
      if (!mapping.organizationId && !entity) throw new Error(`mapping target does not exist: ${mapping.entityId}`);
      return { ...mapping, organizationId: mapping.organizationId ?? entity!.organizationId };
    }));
    await this.db.collection(ENTITY_MAPPINGS_COLLECTION).bulkWrite(resolved.map((mapping) => ({ replaceOne: { filter: mapping, replacement: mapping, upsert: true } })));
  }

  private async isStale(delivery: SourceDelivery, session: ClientSession): Promise<boolean> {
    if (!/^\d+$/.test(delivery.sourceRevision)) return false;
    const current = await this.db.collection(SOURCE_DELIVERIES_COLLECTION).find({ organizationId: delivery.organizationId, sourceInstanceId: delivery.sourceInstanceId, sourceObjectId: delivery.sourceObjectId, sourceRevision: { $regex: "^\\d+$" } }, { session, projection: { sourceRevision: 1 } }).toArray();
    return current.some(({ sourceRevision }) => BigInt(sourceRevision as string) > BigInt(delivery.sourceRevision));
  }

  private async postingScopesExist(organizationId: string, posting: Posting, session: ClientSession): Promise<boolean> {
    const ids = posting.scopes.map((scope) => scope.id);
    const entities = await this.db.collection(IMPORT_ENTITIES_COLLECTION).find({ organizationId, entityId: { $in: ids } }, { session, projection: { _id: 0, entityId: 1, kind: 1 } }).toArray();
    return entities.length === ids.length && posting.scopes.every((scope) => entities.some((entity) => entity.entityId === scope.id && entity.kind === (scope.type === "account" ? "financial_account" : scope.type)));
  }

  private async mappedEntity(delivery: SourceDelivery, session: ClientSession): Promise<{ entityId: string; revision: number } | null> {
    const sourceObjectId = typeof delivery.payload.repository === "string" ? `repo/${delivery.payload.repository}` : delivery.sourceObjectId;
    const mapping = await this.db.collection(ENTITY_MAPPINGS_COLLECTION).findOne({ organizationId: delivery.organizationId, sourceInstanceId: delivery.sourceInstanceId, sourceObjectId }, { session });
    if (!mapping) return null;
    return this.db.collection(IMPORT_ENTITIES_COLLECTION).findOne({ organizationId: delivery.organizationId, entityId: mapping.entityId }, { session, projection: { _id: 0, entityId: 1, revision: 1 } }) as Promise<{ entityId: string; revision: number } | null>;
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceHash(delivery: SourceDelivery): string {
  const { deliveryId: _deliveryId, observedAt: _observedAt, provenance, ...source } = delivery;
  const { observedAt: _provenanceObservedAt, ...sourceProvenance } = provenance;
  return hash({ ...source, provenance: sourceProvenance });
}
