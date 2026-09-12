import type { Collection, Db } from "mongodb";

/** Collection used by tests to observe transaction and isolation behavior. */
export const PROBE_COLLECTION = "test_probe";

export interface ProbeDocument {
  readonly _id: string;
  readonly note?: string;
}

export function probeCollection(db: Db): Collection<ProbeDocument> {
  return db.collection<ProbeDocument>(PROBE_COLLECTION);
}
