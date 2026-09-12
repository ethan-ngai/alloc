import {
  ContractErrorSchema,
  type ContractError,
  type DurableJobMessage,
} from "@alloc/contracts";
import type { SchedulerRepository } from "./repository.js";
import {
  type AdmissionPolicy,
  type FairnessState,
  type JobType,
  type LeaseToken,
  type RetryPolicy,
  type StepRelease,
  DEFAULT_ADMISSION_POLICY,
  DEFAULT_RETRY_POLICY,
  INITIAL_FAIRNESS_STATE,
  SchedulerInvariantError,
  decideRetry,
} from "./scheduler.js";

export interface JobHandlerContext {
  lease: LeaseToken;
  renew(leaseDurationMs?: number): Promise<DurableJobMessage>;
}

export type JobHandler = (
  job: DurableJobMessage,
  context: JobHandlerContext,
) => Promise<StepRelease>;

export type JobHandlers = Partial<Record<JobType, JobHandler>>;

export interface SchedulerWorkerOptions {
  workerId: string;
  leaseDurationMs: number;
  admissionPolicy?: AdmissionPolicy;
  retryPolicy?: RetryPolicy;
  clock?: () => Date;
}

export type WorkerRunResult =
  | {
      status: "idle";
      expiredJobIds: string[];
      principalLimitedJobIds: string[];
    }
  | { status: "released"; job: DurableJobMessage }
  | { status: "fenced"; jobId: string; reason: SchedulerInvariantError["code"] };

export class JobExecutionError extends Error {
  readonly contractError: ContractError;

  constructor(errorInput: ContractError) {
    const error = ContractErrorSchema.parse(errorInput);
    super(error.message);
    this.name = "JobExecutionError";
    this.contractError = error;
  }
}

function isFencingError(error: unknown): error is SchedulerInvariantError {
  return error instanceof SchedulerInvariantError && error.code.startsWith("LEASE_");
}

export class SchedulerWorker {
  #fairness: FairnessState = INITIAL_FAIRNESS_STATE;
  readonly #clock: () => Date;
  readonly #admissionPolicy: AdmissionPolicy;
  readonly #retryPolicy: RetryPolicy;

  constructor(
    readonly repository: SchedulerRepository,
    readonly handlers: JobHandlers,
    readonly options: SchedulerWorkerOptions,
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#admissionPolicy = options.admissionPolicy ?? DEFAULT_ADMISSION_POLICY;
    this.#retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  get fairness(): FairnessState {
    return { ...this.#fairness };
  }

  async runOnce(): Promise<WorkerRunResult> {
    const admissionNow = this.#clock();
    const expired = await this.repository.expireDeadlines(admissionNow);
    const claim = await this.repository.claimNext({
      workerId: this.options.workerId,
      now: admissionNow,
      leaseDurationMs: this.options.leaseDurationMs,
      fairness: this.#fairness,
      policy: this.#admissionPolicy,
    });
    this.#fairness = claim.fairness;
    if (claim.job === null) {
      return {
        status: "idle",
        expiredJobIds: [...new Set([
          ...expired.map(({ jobId }) => jobId),
          ...claim.expiredJobIds,
        ])].sort(),
        principalLimitedJobIds: claim.principalLimitedJobIds,
      };
    }

    const claimed = claim.job;
    if (claimed.lease === null) {
      throw new Error("repository returned a claimed job without a lease");
    }
    const lease: LeaseToken = {
      ownerId: claimed.lease.ownerId,
      generation: claimed.lease.generation,
    };
    const handler = this.handlers[claimed.jobType];

    try {
      if (handler === undefined) {
        throw new JobExecutionError({
          schemaVersion: claimed.schemaVersion,
          code: "DEPENDENCY_UNAVAILABLE",
          message: `no handler registered for ${claimed.jobType}`,
          retryable: true,
          correlationId: `correlation_${claimed.jobId}`,
        });
      }
      const release = await handler(claimed, {
        lease,
        renew: async (leaseDurationMs = this.options.leaseDurationMs) =>
          this.repository.renew(claimed.jobId, lease, this.#clock(), leaseDurationMs),
      });
      const released = await this.repository.release(
        claimed.jobId,
        lease,
        this.#clock(),
        release,
      );
      return { status: "released", job: released };
    } catch (error) {
      if (isFencingError(error)) {
        return { status: "fenced", jobId: claimed.jobId, reason: error.code };
      }
      const contractError = error instanceof JobExecutionError
        ? error.contractError
        : ContractErrorSchema.parse({
            schemaVersion: claimed.schemaVersion,
            code: "INTERNAL_ERROR",
            message: "job handler failed unexpectedly",
            retryable: true,
            correlationId: `correlation_${claimed.jobId}`,
          });
      const decision = decideRetry(
        contractError,
        claimed.attempts,
        this.#clock(),
        this.#retryPolicy,
      );
      const release: StepRelease = decision.action === "retry"
        ? {
            state: "waiting_for_retry",
            currentStep: claimed.currentStep,
            checkpointRefs: claimed.checkpointRefs,
            eligibleAt: decision.eligibleAt,
          }
        : {
            state: "failed",
            currentStep: claimed.currentStep,
            checkpointRefs: claimed.checkpointRefs,
          };
      try {
        const released = await this.repository.release(
          claimed.jobId,
          lease,
          this.#clock(),
          release,
        );
        return { status: "released", job: released };
      } catch (releaseError) {
        if (isFencingError(releaseError)) {
          return { status: "fenced", jobId: claimed.jobId, reason: releaseError.code };
        }
        throw releaseError;
      }
    }
  }
}
