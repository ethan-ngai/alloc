/**
 * Scheduler-facing seam for action delivery.
 *
 * `enqueueActionableIntents` produces one durable job per actionable intent and
 * `createActionJobHandler` executes it. A non-failed job owns its intent: the
 * producer only produces when no job owns it, or when the job that owned it
 * ended terminally failed, and job IDs are deterministic from the intent and the
 * attempt ordinal, so a crashed producer cannot double-deliver work.
 *
 * The handler keeps its job alive while an outcome stays unresolved — a provider
 * that cannot be reached is retried with the scheduler's capped exponential
 * backoff — and completes only once every intent it was given settled. A job
 * whose deadline expires leaves the intent visibly `outcome_unknown` with its
 * exposure retained, for explicit handling rather than a silent release.
 */
import {
  ActionIntentSchema, CONTRACT_SCHEMA_VERSION, DurableJobMessageSchema,
  type ActionIntent, type DurableJobMessage, type RecordRef,
} from "@alloc/contracts";
import {
  DEFAULT_RETRY_POLICY, JobExecutionError, SchedulerInvariantError,
  type JobHandler, type SchedulerRepository, type StepRelease,
} from "@alloc/scheduler";
import type { Db } from "mongodb";
import { ACTION_INTENTS_COLLECTION, REQUEST_REVISIONS_COLLECTION } from "../finance/collections.js";
import { recordId } from "../finance/ids.js";
import { EXECUTOR_SERVICE_IDENTITY, MongoActionExecutor, type IntentOutcome } from "./executor.js";

/** The contract's job type for delivering an approved action and reconciling it. */
export const ACTION_JOB_TYPE = "reconciliation";
/** Delivery is operational work: essential P1 yields to interactive P0 and never starves behind P2. */
export const ACTION_JOB_PRIORITY = "P1";
export const ACTION_JOB_DEDUPLICATION_PREFIX = "action_dispatch";
/** Past this bound an unresolved action stops retrying and waits for explicit handling. */
export const ACTION_JOB_DEADLINE_MS = 60 * 60 * 1_000;
const ACTION_INTENT_REF = "action_intent";

export interface ActionJobOptions {
  readonly organizationId?: string;
  readonly limit?: number;
  readonly now?: Date;
}

export interface ActionJobScan {
  readonly enqueued: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Produces jobs for actionable intents. Ownership is per intent, not per
 * revision: claiming an intent advances its revision, and the job that holds it
 * must not be duplicated just because the revision moved.
 */
export async function enqueueActionableIntents(
  db: Db,
  jobs: SchedulerRepository,
  options: ActionJobOptions = {},
): Promise<ActionJobScan> {
  const now = options.now ?? new Date();
  const documents = await db.collection(ACTION_INTENTS_COLLECTION)
    .find({
      state: { $in: ["pending", "dispatching", "outcome_unknown"] },
      ...(options.organizationId === undefined ? {} : { organizationId: options.organizationId }),
    }, { projection: { _id: 0 } })
    .sort({ createdAt: 1, actionIntentId: 1 })
    .limit(options.limit ?? 10)
    .toArray();
  if (documents.length === 0) {
    return { enqueued: [], skipped: [] };
  }

  const byKey = new Map<string, DurableJobMessage[]>();
  for (const job of await jobs.list()) {
    const bucket = byKey.get(job.deduplicationKey);
    if (bucket === undefined) {
      byKey.set(job.deduplicationKey, [job]);
    } else {
      bucket.push(job);
    }
  }

  const enqueued: string[] = [];
  const skipped: string[] = [];
  for (const document of documents) {
    const intent = ActionIntentSchema.parse(document);
    const deduplicationKey = `${ACTION_JOB_DEDUPLICATION_PREFIX}:${intent.actionIntentId}`;
    const forIntent = byKey.get(deduplicationKey) ?? [];
    const covered = forIntent.some((job) => job.state !== "failed" && job.state !== "canceled");
    if (covered) {
      skipped.push(intent.actionIntentId);
      continue;
    }
    const job = await buildActionJob(db, intent, forIntent.length, now);
    try {
      await jobs.enqueue(job);
      enqueued.push(job.jobId);
      byKey.set(deduplicationKey, [...forIntent, job]);
    } catch (error) {
      // Two producers can build the same job from the same intent; the loser
      // observes the winner's job on its next pass.
      if (error instanceof SchedulerInvariantError && error.code === "COALESCING_CONFLICT") {
        skipped.push(intent.actionIntentId);
        continue;
      }
      throw error;
    }
  }
  return { enqueued, skipped };
}

export interface ActionJobHandlerOptions {
  readonly batchSize?: number;
  readonly now?: () => Date;
}

/**
 * Builds the `reconciliation` handler. A job naming intents settles exactly
 * those; a job naming none sweeps the organization's actionable intents.
 */
export function createActionJobHandler(
  executor: MongoActionExecutor,
  options: ActionJobHandlerOptions = {},
): JobHandler {
  const batchSize = options.batchSize ?? 5;
  const now = options.now ?? (() => new Date());
  return async (job, context) => {
    const targets = job.inputVersions.filter((reference) => reference.type === ACTION_INTENT_REF);
    const outcomes: IntentOutcome[] = [];
    if (targets.length === 0) {
      outcomes.push(...(await executor.runOnce({ organizationId: job.organizationId, limit: batchSize })).results);
    } else {
      for (const [index, target] of targets.entries()) {
        if (index > 0) {
          // A step that settles several intents can outlive its first lease.
          await context.renew();
        }
        outcomes.push(await executor.runIntent(job.organizationId, target.id));
      }
    }

    for (const outcome of outcomes) {
      if (outcome.status === "error") {
        throw new JobExecutionError({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          code: "DEPENDENCY_UNAVAILABLE",
          message: `action delivery failed for ${outcome.intent.actionIntentId}: ${outcome.reason}`,
          retryable: true,
          correlationId: recordId("correlation", job.jobId, job.revision),
        });
      }
    }

    const checkpointRefs = checkpointRefsOf(outcomes);
    const unresolved = outcomes.some((outcome) => outcome.status === "outcome_unknown" || outcome.status === "pending");
    if (!unresolved) {
      return { state: "completed", currentStep: "action_delivery_settled", checkpointRefs };
    }
    const delayMs = Math.min(
      DEFAULT_RETRY_POLICY.baseDelayMs * (2 ** Math.min(job.attempts, 16)),
      DEFAULT_RETRY_POLICY.maxDelayMs,
    );
    return {
      state: "waiting_for_retry",
      currentStep: "action_delivery_unresolved",
      checkpointRefs,
      eligibleAt: new Date(now().getTime() + delayMs).toISOString(),
    };
  };
}

function checkpointRefsOf(outcomes: readonly IntentOutcome[]): RecordRef[] {
  const byIntent = new Map<string, RecordRef>();
  for (const outcome of outcomes) {
    if (!("intent" in outcome)) {
      continue;
    }
    const ref: RecordRef = { type: ACTION_INTENT_REF, id: outcome.intent.actionIntentId, revision: outcome.intent.revision };
    const previous = byIntent.get(ref.id);
    if (previous === undefined || (previous.revision ?? 0) < outcome.intent.revision) {
      byIntent.set(ref.id, ref);
    }
  }
  return [...byIntent.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function buildActionJob(db: Db, intent: ActionIntent, ordinal: number, now: Date): Promise<DurableJobMessage> {
  const request = await db.collection(REQUEST_REVISIONS_COLLECTION).findOne(
    { organizationId: intent.organizationId, requestId: intent.requestRef.id, revision: intent.requestRef.revision },
    { projection: { _id: 0, requesterId: 1 } },
  );
  const requesterId = typeof request?.requesterId === "string" ? request.requesterId : EXECUTOR_SERVICE_IDENTITY;
  const nowIso = now.toISOString();
  return DurableJobMessageSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: intent.organizationId,
    jobId: recordId("job", intent.organizationId, intent.actionIntentId, intent.revision, ordinal),
    revision: 1,
    jobType: ACTION_JOB_TYPE,
    originPrincipalId: requesterId,
    serviceIdentityId: EXECUTOR_SERVICE_IDENTITY,
    scope: { type: "organization", id: intent.organizationId },
    priority: ACTION_JOB_PRIORITY,
    state: "pending",
    inputVersions: [{ type: ACTION_INTENT_REF, id: intent.actionIntentId, revision: intent.revision }],
    deduplicationKey: `${ACTION_JOB_DEDUPLICATION_PREFIX}:${intent.actionIntentId}`,
    currentStep: "action_delivery_queued",
    checkpointRefs: [],
    attempts: 0,
    eligibleAt: nowIso,
    deadlineAt: new Date(now.getTime() + ACTION_JOB_DEADLINE_MS).toISOString(),
    lease: null,
  });
}
