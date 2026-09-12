import type { DurableJobMessage } from "@alloc/contracts";
import { MongoServerError, type Collection, type Db } from "mongodb";
import {
  type AdmissionPolicy,
  type FairnessState,
  type LeaseToken,
  type StepRelease,
  DEFAULT_ADMISSION_POLICY,
  INITIAL_FAIRNESS_STATE,
  SchedulerInvariantError,
  claimJob,
  parseDurableJob,
  releaseStep,
  renewLease,
  selectNextJob,
} from "./scheduler.js";
import type { ClaimOptions, ClaimResult, EnqueueResult, SchedulerRepository } from "./repository.js";

interface MongoJobDocument {
  _id: string;
  job: DurableJobMessage;
  lastLeaseGeneration: number;
}

const COLLECTION = "scheduler_jobs";
const MAX_CAS_ATTEMPTS = 100;

export async function ensureSchedulerCollection(db: Db): Promise<void> {
  const exists = await db.listCollections({ name: COLLECTION }, { nameOnly: true }).hasNext();
  if (!exists) {
    try {
      await db.createCollection(COLLECTION, {
        validator: { $jsonSchema: {
          bsonType: "object",
          required: ["_id", "job", "lastLeaseGeneration"],
          properties: {
            _id: { bsonType: "string" },
            job: { bsonType: "object" },
            lastLeaseGeneration: { bsonType: "number", minimum: 0 },
          },
        } },
      });
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.codeName !== "NamespaceExists") throw error;
    }
  }
  await db.collection<MongoJobDocument>(COLLECTION).createIndexes([
    { key: { "job.state": 1, "job.priority": 1, "job.eligibleAt": 1 }, name: "scheduler_admission" },
    { key: { "job.organizationId": 1, "job.deduplicationKey": 1 }, name: "scheduler_coalescing" },
    { key: { "job.deadlineAt": 1 }, name: "scheduler_deadlines" },
  ]);
}

function sameJob(left: DurableJobMessage, right: DurableJobMessage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Mongo-backed lease repository. Every worker mutation is revision-CAS fenced. */
export class MongoSchedulerRepository implements SchedulerRepository {
  readonly #collection: Collection<MongoJobDocument>;

  constructor(db: Db) {
    this.#collection = db.collection<MongoJobDocument>(COLLECTION);
  }

  async enqueue(jobInput: DurableJobMessage): Promise<EnqueueResult> {
    const job = parseDurableJob(jobInput);
    try {
      await this.#collection.insertOne({ _id: job.jobId, job, lastLeaseGeneration: 0 });
      return { action: "created", job };
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      const existing = await this.get(job.jobId);
      if (existing !== null && sameJob(existing, job)) return { action: "deduplicated", job: existing };
      throw new SchedulerInvariantError("COALESCING_CONFLICT", `job ID ${job.jobId} was reused with a different payload`);
    }
  }

  async claimNext(options: ClaimOptions): Promise<ClaimResult> {
    let fairness = options.fairness ?? INITIAL_FAIRNESS_STATE;
    const policy = options.policy ?? DEFAULT_ADMISSION_POLICY;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const documents = await this.#collection.find({}).toArray();
      const admission = selectNextJob(documents.map(({ job }) => parseDurableJob(job)), options.now, fairness, policy);
      fairness = admission.fairness;
      if (admission.selected === null) return { ...admission, job: null };
      const stored = documents.find(({ _id }) => _id === admission.selected?.jobId);
      if (stored === undefined) continue;
      const claimed = claimJob(stored.job, options.workerId, stored.lastLeaseGeneration, options.now, options.leaseDurationMs);
      const updated = await this.#collection.findOneAndUpdate(
        { _id: stored._id, "job.revision": stored.job.revision },
        { $set: { job: claimed, lastLeaseGeneration: claimed.lease!.generation } },
        { returnDocument: "after" },
      );
      if (updated !== null) {
        return {
          job: parseDurableJob(updated.job),
          fairness,
          expiredJobIds: admission.expiredJobIds,
          principalLimitedJobIds: admission.principalLimitedJobIds,
        };
      }
    }
    throw new Error("scheduler claim contention exceeded retry bound");
  }

  renew(jobId: string, token: LeaseToken, now: Date, leaseDurationMs: number): Promise<DurableJobMessage> {
    return this.#mutate(jobId, (job) => renewLease(job, token, now, leaseDurationMs));
  }

  release(jobId: string, token: LeaseToken, now: Date, release: StepRelease): Promise<DurableJobMessage> {
    return this.#mutate(jobId, (job) => releaseStep(job, token, now, release));
  }

  cancel(jobId: string, expectedRevision: number, currentStep: string): Promise<DurableJobMessage> {
    return this.#mutate(jobId, (job) => {
      if (job.revision !== expectedRevision) {
        throw new SchedulerInvariantError("REVISION_MISMATCH", `expected job revision ${expectedRevision}, found ${job.revision}`);
      }
      if (job.state === "canceled") return job;
      if (job.state === "completed" || job.state === "failed") {
        throw new SchedulerInvariantError("JOB_NOT_CLAIMABLE", `cannot cancel terminal ${job.state} job`);
      }
      return parseDurableJob({ ...job, revision: job.revision + 1, state: "canceled", currentStep, lease: null });
    });
  }

  async expireDeadlines(now: Date): Promise<DurableJobMessage[]> {
    const candidates = await this.#collection.find({
      "job.deadlineAt": { $ne: null, $lte: now.toISOString() },
      "job.state": { $nin: ["completed", "failed", "canceled"] },
    }).toArray();
    const expired: DurableJobMessage[] = [];
    for (const { job } of candidates) {
      try {
        expired.push(await this.#mutate(job.jobId, (current) => {
          if (current.deadlineAt === null || Date.parse(current.deadlineAt) > now.getTime()) return current;
          if (current.state === "completed" || current.state === "failed" || current.state === "canceled") return current;
          return parseDurableJob({ ...current, revision: current.revision + 1, state: "failed", currentStep: "deadline_expired", lease: null });
        }));
      } catch (error) {
        if (!(error instanceof SchedulerInvariantError) || error.code !== "REVISION_MISMATCH") throw error;
      }
    }
    return expired.filter(({ state, currentStep }) => state === "failed" && currentStep === "deadline_expired")
      .sort((left, right) => left.jobId.localeCompare(right.jobId));
  }

  async get(jobId: string): Promise<DurableJobMessage | null> {
    const document = await this.#collection.findOne({ _id: jobId });
    return document === null ? null : parseDurableJob(document.job);
  }

  async list(): Promise<DurableJobMessage[]> {
    return (await this.#collection.find({}).toArray()).map(({ job }) => parseDurableJob(job))
      .sort((left, right) => left.jobId.localeCompare(right.jobId));
  }

  async #mutate(jobId: string, change: (job: DurableJobMessage) => DurableJobMessage): Promise<DurableJobMessage> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const stored = await this.#collection.findOne({ _id: jobId });
      if (stored === null) throw new Error(`job not found: ${jobId}`);
      const next = change(parseDurableJob(stored.job));
      if (sameJob(next, stored.job)) return next;
      const updated = await this.#collection.findOneAndUpdate(
        { _id: jobId, "job.revision": stored.job.revision },
        { $set: { job: next } },
        { returnDocument: "after" },
      );
      if (updated !== null) return parseDurableJob(updated.job);
    }
    throw new SchedulerInvariantError("REVISION_MISMATCH", `job ${jobId} changed during every retry`);
  }
}
