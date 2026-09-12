import { createHash } from "node:crypto";
import { CONTRACT_SCHEMA_VERSION, CompanyEntitySchema, EvidenceSchema, GraphContextSchema, RelationshipSchema, type CompanyEntity, type Evidence, type GraphContext, type Relationship } from "@alloc/contracts";
import type { Db } from "mongodb";
import type { Principal } from "../auth/principal.js";
import { IMPORT_ENTITIES_COLLECTION } from "../imports/repository.js";

export const RELATIONSHIPS_COLLECTION = "relationships";
const EVIDENCE_COLLECTION = "evidence";
const SUMMARIES_COLLECTION = "scope_summaries";

export interface GraphQuery {
  readonly subjectId: string;
  readonly relationshipTypes: readonly string[];
  readonly maxHops: number;
  readonly maxEntities: number;
  readonly asOf: string;
}

export interface GraphRepository {
  query(organizationId: string, principal: Principal, input: GraphQuery): Promise<GraphContext>;
  seedRelationships(relationships: readonly Relationship[]): Promise<void>;
  seedEvidence(evidence: readonly Evidence[]): Promise<void>;
  getEvidence(organizationId: string, principal: Principal, evidenceId: string, revision: number | undefined): Promise<Evidence>;
}

export async function ensureGraphCollections(db: Db): Promise<void> {
  await Promise.all([
    db.collection(RELATIONSHIPS_COLLECTION).createIndexes([
      { key: { organizationId: 1, fromId: 1, type: 1, validTo: 1 }, name: "relationship_forward" },
      { key: { organizationId: 1, toId: 1, type: 1, validTo: 1 }, name: "relationship_reverse" },
      { key: { organizationId: 1, relationshipId: 1 }, name: "relationship_identity", unique: true },
    ]),
    db.collection(SUMMARIES_COLLECTION).createIndex({ organizationId: 1, cacheKey: 1 }, { name: "summary_cache", unique: true }),
    db.collection(EVIDENCE_COLLECTION).createIndex({ organizationId: 1, evidenceId: 1, revision: 1 }, { name: "evidence_identity", unique: true }),
  ]);
}

export class MongoGraphRepository implements GraphRepository {
  constructor(private readonly db: Db) {}

  async seedRelationships(relationships: readonly Relationship[]): Promise<void> {
    if (!relationships.length) return;
    for (const candidate of relationships) {
      const relationship = RelationshipSchema.parse(candidate);
      if (relationship.verification !== "verified") throw new Error("only verified relationships may enter the graph");
      const count = await this.db.collection(IMPORT_ENTITIES_COLLECTION).countDocuments({ organizationId: relationship.organizationId, entityId: { $in: [relationship.fromId, relationship.toId] } });
      if (count !== 2) throw new Error("relationship endpoint does not exist");
      await this.db.collection(RELATIONSHIPS_COLLECTION).replaceOne(
        { organizationId: relationship.organizationId, relationshipId: relationship.relationshipId }, relationship, { upsert: true },
      );
    }
  }

  async seedEvidence(evidence: readonly Evidence[]): Promise<void> {
    if (!evidence.length) return;
    await this.db.collection(EVIDENCE_COLLECTION).bulkWrite(evidence.map((candidate) => {
      const item = EvidenceSchema.parse(candidate);
      return { replaceOne: { filter: { organizationId: item.organizationId, evidenceId: item.evidenceId, revision: item.revision }, replacement: item, upsert: true } };
    }));
  }

  async getEvidence(organizationId: string, principal: Principal, evidenceId: string, revision: number | undefined): Promise<Evidence> {
    const evidence = await this.db.collection<Evidence>(EVIDENCE_COLLECTION).findOne({ organizationId, evidenceId, ...(revision === undefined ? {} : { revision }) }, { projection: { _id: 0 }, sort: { revision: -1 } });
    if (!evidence || !accessible(evidence, principal)) throw new GraphAccessError();
    return EvidenceSchema.parse(evidence);
  }

  async query(organizationId: string, principal: Principal, input: GraphQuery): Promise<GraphContext> {
    const entityMap = new Map((await this.db.collection<CompanyEntity>(IMPORT_ENTITIES_COLLECTION).find({ organizationId }, { projection: { _id: 0 } }).toArray()).map((entity) => [entity.entityId, CompanyEntitySchema.parse(entity)]));
    const subject = entityMap.get(input.subjectId);
    if (!subject || !accessible(subject, principal)) throw new GraphAccessError();

    const relationships = (await this.db.collection<Relationship>(RELATIONSHIPS_COLLECTION).find({
      organizationId, verification: "verified", validFrom: { $lte: input.asOf }, $or: [{ validTo: null }, { validTo: { $gt: input.asOf } }],
    }, { projection: { _id: 0 } }).toArray()).map((relationship) => RelationshipSchema.parse(relationship)).filter((relationship) => !input.relationshipTypes.length || input.relationshipTypes.includes(relationship.type));

    const visited = new Set([subject.entityId]);
    const selected: Relationship[] = [];
    const selectedIds = new Set<string>();
    let truncated = false;
    let frontier = [subject.entityId];
    for (let hop = 0; hop < input.maxHops && frontier.length && visited.size < input.maxEntities; hop += 1) {
      const next: string[] = [];
      for (const relationship of relationships) {
        if (selectedIds.has(relationship.relationshipId)) continue;
        if (!frontier.includes(relationship.fromId) && !frontier.includes(relationship.toId)) continue;
        const other = frontier.includes(relationship.fromId) ? relationship.toId : relationship.fromId;
        const from = entityMap.get(relationship.fromId);
        const to = entityMap.get(relationship.toId);
        if (!from || !to || !accessible(relationship, principal) || !accessible(from, principal) || !accessible(to, principal)) continue;
        if (!visited.has(other) && visited.size === input.maxEntities) { truncated = true; continue; }
        selected.push(relationship);
        selectedIds.add(relationship.relationshipId);
        if (!visited.has(other)) { visited.add(other); next.push(other); }
      }
      frontier = next;
    }
    const entities = [...visited].map((id) => entityMap.get(id)!).filter((entity) => accessible(entity, principal));
    const evidenceRefs = selected.flatMap((relationship) => relationship.evidenceRefs).filter((ref, index, all) => all.findIndex((other) => other.type === ref.type && other.id === ref.id && other.revision === ref.revision) === index);
    const sourceWatermark = fingerprint({ entities: entities.map(version), relationships: selected.map(version), evidenceRefs });
    const cacheKey = fingerprint({ organizationId, principalId: principal.principalId, subjectId: input.subjectId, relationshipTypes: [...input.relationshipTypes].sort(), maxHops: input.maxHops, maxEntities: input.maxEntities, sourceWatermark });
    const cached = await this.db.collection<{ summary: string }>(SUMMARIES_COLLECTION).findOne({ organizationId, cacheKey }, { projection: { _id: 0, summary: 1 } });
    const summary = cached?.summary ?? `${selected.length} verified relationship${selected.length === 1 ? "" : "s"} across ${entities.length} accessible entit${entities.length === 1 ? "y" : "ies"}.`;
    if (!cached) await this.db.collection(SUMMARIES_COLLECTION).insertOne({ organizationId, cacheKey, summary, sourceWatermark, createdAt: new Date().toISOString() });
    return GraphContextSchema.parse({ schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId, subjectRef: { type: "entity", id: subject.entityId }, entities, relationships: selected, evidenceRefs, summary, sourceWatermark, truncated: truncated || (frontier.length > 0 && input.maxHops > 0) });
  }
}

export class GraphAccessError extends Error { override readonly name = "GraphAccessError"; }

function accessible(record: { access: { classification: string; allowedPrincipalIds: readonly string[] } }, principal: Principal): boolean {
  return record.access.classification !== "restricted" || record.access.allowedPrincipalIds.includes(principal.principalId);
}
function version(record: { entityId?: string; relationshipId?: string; revision: number; access: unknown }): unknown { return { id: record.entityId ?? record.relationshipId, revision: record.revision, access: record.access }; }
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
