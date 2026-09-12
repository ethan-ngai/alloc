import { createHash } from "node:crypto";
import { ForecastCalculationInputSchema, ForecastSnapshotSchema, type ForecastCalculationInput, type ForecastSnapshot } from "@alloc/contracts";
import { calculateForecast } from "@alloc/forecast";
import type { ClientSession, Db } from "mongodb";

export const FORECAST_SNAPSHOTS_COLLECTION = "forecast_snapshots";
export const FORECAST_CURRENT_COLLECTION = "forecast_current";
export const FORECAST_REFRESHES_COLLECTION = "forecast_refreshes";

export interface ForecastRepository {
  refresh(input: ForecastCalculationInput): Promise<ForecastSnapshot>;
  get(organizationId: string, forecastId: string, revision?: number): Promise<ForecastSnapshot | null>;
  schedule(input: ForecastRefreshInput, session?: ClientSession): Promise<void>;
}

export interface ForecastRefreshInput {
  readonly organizationId: string;
  readonly scope: { readonly type: string; readonly id: string };
  readonly sourceWatermark: { readonly sourceInstanceId: string; readonly observedAt: string };
}

export async function ensureForecastCollections(db: Db): Promise<void> {
  await Promise.all([
    db.collection(FORECAST_SNAPSHOTS_COLLECTION).createIndexes([
      { key: { organizationId: 1, forecastId: 1, revision: 1 }, name: "snapshot_identity", unique: true },
      { key: { organizationId: 1, forecastId: 1, inputHash: 1 }, name: "snapshot_input", unique: true },
    ]),
    db.collection(FORECAST_CURRENT_COLLECTION).createIndex({ organizationId: 1, forecastId: 1 }, { name: "forecast_identity", unique: true }),
    db.collection(FORECAST_REFRESHES_COLLECTION).createIndex({ organizationId: 1, "scope.type": 1, "scope.id": 1 }, { name: "refresh_scope", unique: true }),
  ]);
}

/** Immutable forecast history with a pointer to the latest completed snapshot. */
export class MongoForecastRepository implements ForecastRepository {
  constructor(private readonly db: Db, private readonly withTransaction: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>) {}

  async refresh(candidate: ForecastCalculationInput): Promise<ForecastSnapshot> {
    const input = ForecastCalculationInputSchema.parse(candidate);
    const inputHash = hash(canonicalForecastInput(input));
    return this.withTransaction(async (session) => {
      const snapshots = this.db.collection(FORECAST_SNAPSHOTS_COLLECTION);
      const duplicate = await snapshots.findOne({ organizationId: input.organizationId, forecastId: input.forecastId, inputHash }, { session, projection: { _id: 0, inputHash: 0 } });
      if (duplicate) return ForecastSnapshotSchema.parse(duplicate);

      const current = await this.db.collection(FORECAST_CURRENT_COLLECTION).findOne({ organizationId: input.organizationId, forecastId: input.forecastId }, { session, projection: { _id: 0, revision: 1 } });
      const revision = (current?.revision as number | undefined ?? 0) + 1;
      const snapshot = ForecastSnapshotSchema.parse({
        ...calculateForecast({ ...input, revision }),
        ...(revision > 1 ? { correctsForecastRef: { type: "forecast", id: input.forecastId, revision: revision - 1 } } : {}),
      });
      await snapshots.insertOne({ ...snapshot, inputHash }, { session });
      await this.db.collection(FORECAST_CURRENT_COLLECTION).replaceOne(
        { organizationId: input.organizationId, forecastId: input.forecastId },
        { organizationId: input.organizationId, forecastId: input.forecastId, revision },
        { session, upsert: true },
      );
      return snapshot;
    });
  }

  async get(organizationId: string, forecastId: string, revision?: number): Promise<ForecastSnapshot | null> {
    const selectedRevision = revision ?? (await this.db.collection(FORECAST_CURRENT_COLLECTION).findOne({ organizationId, forecastId }, { projection: { _id: 0, revision: 1 } }))?.revision;
    if (typeof selectedRevision !== "number") return null;
    const snapshot = await this.db.collection(FORECAST_SNAPSHOTS_COLLECTION).findOne({ organizationId, forecastId, revision: selectedRevision }, { projection: { _id: 0, inputHash: 0 } });
    return snapshot ? ForecastSnapshotSchema.parse(snapshot) : null;
  }

  async schedule(input: ForecastRefreshInput, session?: ClientSession): Promise<void> {
    const work = async (activeSession: ClientSession): Promise<void> => {
      const key = { organizationId: input.organizationId, "scope.type": input.scope.type, "scope.id": input.scope.id };
      await this.db.collection(FORECAST_REFRESHES_COLLECTION).updateOne(key, {
        $set: { organizationId: input.organizationId, scope: input.scope, state: "pending", updatedAt: input.sourceWatermark.observedAt, [`sourceWatermarks.${input.sourceWatermark.sourceInstanceId}`]: input.sourceWatermark.observedAt },
        $inc: { generation: 1 },
      }, { session: activeSession, upsert: true });
    };
    if (session) return work(session);
    return this.withTransaction(work);
  }
}

/** Exact component-by-component change for a linked forecast revision. */
export function contributionDeltas(current: ForecastSnapshot, prior: ForecastSnapshot): Array<{ kind: string; amountMinor: number }> {
  const totals = (snapshot: ForecastSnapshot) => snapshot.components.reduce((result, { kind, amount }) => result.set(kind, (result.get(kind) ?? 0) + amount.amountMinor), new Map<string, number>());
  const currentTotals = totals(current);
  const priorTotals = totals(prior);
  return Array.from(new Set([...currentTotals.keys(), ...priorTotals.keys()]), (kind) => ({ kind, amountMinor: (currentTotals.get(kind) ?? 0) - (priorTotals.get(kind) ?? 0) }));
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalForecastInput(input: ReturnType<typeof ForecastCalculationInputSchema.parse>): unknown {
  const { postings, commitments, schedules, assumptions, revision: _revision, completedAt: _completedAt, ...rest } = input;
  return {
    ...(canonicalize(rest) as Record<string, unknown>),
    postings: canonicalCollection(postings),
    commitments: canonicalCollection(commitments),
    schedules: canonicalCollection(schedules),
    assumptions: canonicalCollection(assumptions),
  };
}

function canonicalCollection(records: readonly unknown[]): unknown[] {
  return records.map(canonicalize).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
}
