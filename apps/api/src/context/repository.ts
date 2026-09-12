import { CONTRACT_SCHEMA_VERSION, EvidenceSchema, type CompanyEntity, type Evidence, type MemoryResponse, type Posting } from "@alloc/contracts";
import type { Db, Document, Filter } from "mongodb";
import { IMPORT_ENTITIES_COLLECTION, NORMALIZED_POSTINGS_COLLECTION } from "../imports/repository.js";
import type { Principal } from "../auth/principal.js";

type ScopeRef = Posting["scopes"][number];
type MemoryFact = MemoryResponse["facts"][number];
export interface ContextQuery { readonly query: string; readonly scopes: readonly ScopeRef[]; readonly asOf: string; readonly limit: number; readonly cursor?: string; }
export interface ContextRepository { query(organizationId: string, principal: Principal, input: ContextQuery): Promise<MemoryResponse>; }

export async function ensureContextIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection(NORMALIZED_POSTINGS_COLLECTION).createIndex({ organizationId: 1, current: 1, "scopes.id": 1, occurredAt: -1, postingId: 1 }, { name: "financial_context_scope" }),
    db.collection(IMPORT_ENTITIES_COLLECTION).createIndex({ organizationId: 1, "access.scopeRefs.id": 1, entityId: 1 }, { name: "context_entity_scope" }),
  ]);
}

export class MongoContextRepository implements ContextRepository {
  constructor(private readonly db: Db) {}

  async query(organizationId: string, principal: Principal, input: ContextQuery): Promise<MemoryResponse> {
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const allScopes = input.scopes.some((scope) => scope.type === "organization" && scope.id === organizationId);
    const scope = allScopes ? {} : { scopes: { $elemMatch: { $or: input.scopes.map(scopeFilter) } } };
    const after = cursor ? { $or: [{ occurredAt: { $lt: cursor.occurredAt } }, { occurredAt: cursor.occurredAt, postingId: { $gt: cursor.postingId } }] } : {};
    const postings = (await this.db.collection(NORMALIZED_POSTINGS_COLLECTION).find({ organizationId, current: true, occurredAt: { $lte: input.asOf }, ...scope, ...after } satisfies Filter<Document>, { projection: { _id: 0, deliveryRef: 0, sourceInstanceId: 0, sourceObjectId: 0, sourceRevision: 0, current: 0 } }).sort({ occurredAt: -1, postingId: 1 }).limit(input.limit + 1).toArray()) as unknown as Posting[];
    const scopeIds = [...new Set([
      ...input.scopes.map((scope) => scope.id),
      ...postings.flatMap((posting) => posting.scopes.map((scope) => scope.id)),
    ])];
    const entities = (await this.db.collection<CompanyEntity>(IMPORT_ENTITIES_COLLECTION).find({ organizationId, entityId: { $in: scopeIds } }, { projection: { _id: 0 } }).toArray()).filter((entity) => entity.access.classification !== "restricted" || entity.access.allowedPrincipalIds.includes(principal.principalId));
    const names = new Map(entities.map((entity) => [entity.entityId, entity.displayName.toLowerCase()]));
    const matches = (id: string, scopes: readonly ScopeRef[], name?: string) => [id, name, ...scopes.flatMap((item) => [item.id, names.get(item.id)])].some((value) => value?.toLowerCase().includes(input.query.toLowerCase()));
    const visible = postings.filter((posting) => posting.scopes.every((scope) => !scopeIds.includes(scope.id) || entities.some((entity) => entity.entityId === scope.id)) && matches(posting.postingId, posting.scopes)).slice(0, input.limit + 1);
    const pagePostings = visible.slice(0, input.limit);
    const facts: MemoryFact[] = pagePostings.map((posting) => ({ ref: { type: "posting", id: posting.postingId, revision: posting.revision }, label: "Posted spend", value: posting.amount, scopeRefs: posting.scopes, provenance: posting.provenance }));
    const evidence: Evidence[] = pagePostings.map((posting) => EvidenceSchema.parse({ schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId, evidenceId: posting.sourceRef.id, revision: posting.sourceRef.revision ?? 1, kind: "source_record", title: `Posting ${posting.postingId}`, content: `Imported ${posting.status} posting for ${posting.amount.amountMinor} ${posting.amount.currency} minor units.`, access: { classification: "internal", scopeRefs: posting.scopes, allowedPrincipalIds: [] }, provenance: posting.provenance, authoritativeFor: ["posting_amount"] }));
    const last = pagePostings.at(-1);
    return { schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId, queryId: "query_context", asOf: input.asOf, facts, evidence, assumptions: ["Exact imported postings only; commitments and budgets require the 3B financial core."], missingFields: facts.length ? [] : ["facts"], sourceWatermarks: { normalized_postings: pagePostings.reduce((latest, posting) => latest > posting.provenance.sourceRevision ? latest : posting.provenance.sourceRevision, "0") }, page: { nextCursor: visible.length > input.limit && last ? encodeCursor(last) : null, truncated: visible.length > input.limit } };
  }
}

function scopeFilter(scope: ScopeRef): Record<string, string> { return { type: scope.type, id: scope.id }; }
function encodeCursor(posting: Posting): string { return Buffer.from(JSON.stringify({ occurredAt: posting.occurredAt, postingId: posting.postingId })).toString("base64url"); }
function decodeCursor(cursor: string): { occurredAt: string; postingId: string } { try { const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); if (typeof value.occurredAt === "string" && typeof value.postingId === "string") return value; } catch {} throw new Error("invalid context cursor"); }
