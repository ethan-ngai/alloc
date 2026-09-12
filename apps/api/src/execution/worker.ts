/**
 * Durable executor worker.
 *
 * Each pass produces action jobs from the organization's actionable intents and
 * then claims one leased step at a time through `@alloc/scheduler`, so delivery
 * inherits priority admission, lease fencing, checkpointing, and capped retry
 * instead of the bounded poll this process used before task 5A landed. A step
 * that cannot resolve an outcome releases the job as `waiting_for_retry` with
 * backoff and keeps the reservation; a displaced worker is fenced rather than
 * overwriting recovered work.
 *
 * `EXECUTOR_FAULT=crash_after_provider_apply` kills the process between the
 * provider side effect and the receipt write for one named intent, which is how
 * the lease-expiry recovery path is exercised deterministically.
 */
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { MongoSchedulerRepository, SchedulerWorker, type JobHandlers } from "@alloc/scheduler";
import { type LogLevel } from "../config.js";
import { describeError } from "../errors.js";
import { recordId } from "../finance/ids.js";
import { connectMongoRuntime, type MongoRuntime } from "../mongo/runtime.js";
import { redactText } from "../redact.js";
import { loadExecutorConfig, type ExecutorFault } from "./config.js";
import { MongoActionExecutor, type ExecutorHooks } from "./executor.js";
import { ACTION_JOB_TYPE, createActionJobHandler, enqueueActionableIntents } from "./job-handler.js";
import { SimulatedSpendProvider } from "./provider.js";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const LEVEL_RANK: Record<LogLevel, number> = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5, silent: 6 };

async function main(): Promise<void> {
  const config = loadExecutorConfig();
  const logger = createLogger(config.logLevel);
  // The connection string may carry credentials; nothing redacted leaves any log.
  const redact = (text: string): string => redactText(text, [config.mongo.uri]);
  let runtime: MongoRuntime | undefined;
  let stopping = false;
  // Aborting this controller interrupts the loop's pause during shutdown.
  const stopSleep = new AbortController();

  try {
    runtime = await connectMongoRuntime({
      uri: config.mongo.uri,
      database: config.mongo.database,
      serverSelectionTimeoutMs: config.mongo.serverSelectionTimeoutMs,
      heartbeatFrequencyMs: config.mongo.heartbeatFrequencyMs,
    });
    const jobs = new MongoSchedulerRepository(runtime.db);
    const executor = new MongoActionExecutor(
      runtime.db,
      runtime.withTransaction,
      new SimulatedSpendProvider(runtime.db, { failureMode: config.providerFailureMode }),
      () => new Date(),
      faultHook(config.fault, config.faultTarget, logger),
    );
    const handlers: JobHandlers = {
      [ACTION_JOB_TYPE]: createActionJobHandler(executor, { batchSize: config.batchSize }),
    };
    const worker = new SchedulerWorker(jobs, handlers, {
      workerId: recordId("worker", hostname(), process.pid, Date.now()),
      leaseDurationMs: config.leaseDurationMs,
    });

    const shutdown = async (reason: string): Promise<void> => {
      if (stopping) {
        return;
      }
      stopping = true;
      stopSleep.abort();
      logger.info("executor.shutdown", { reason });
      const deadline = setTimeout(() => {
        logger.error("executor.shutdown_timeout", { reason, timeoutMs: config.shutdownTimeoutMs });
        process.exit(1);
      }, config.shutdownTimeoutMs);
      deadline.unref();
      try {
        await runtime?.close();
        clearTimeout(deadline);
        process.exit(0);
      } catch (error) {
        clearTimeout(deadline);
        logger.error("executor.shutdown_failed", { reason, error: describeError(error, redact) });
        process.exit(1);
      }
    };

    for (const signal of SHUTDOWN_SIGNALS) {
      process.on(signal, () => {
        void shutdown(`${signal} received`);
      });
    }
    process.on("uncaughtException", (error) => {
      logger.error("executor.uncaught_exception", { error: describeError(error, redact) });
      void shutdown("uncaught exception");
    });
    process.on("unhandledRejection", (reason) => {
      logger.error("executor.unhandled_rejection", { error: describeError(reason, redact) });
      void shutdown("unhandled rejection");
    });

    logger.info("executor.ready", {
      database: config.mongo.database,
      topology: runtime.topology,
      pollIntervalMs: config.pollIntervalMs,
      batchSize: config.batchSize,
      leaseDurationMs: config.leaseDurationMs,
      fault: config.fault,
      faultTarget: config.faultTarget,
      providerFailureMode: config.providerFailureMode,
    });

    while (!stopping) {
      try {
        const scan = await enqueueActionableIntents(runtime.db, jobs, { limit: config.batchSize });
        if (scan.enqueued.length > 0) {
          logger.info("executor.enqueued", { jobIds: scan.enqueued });
        }
        const result = await worker.runOnce();
        if (result.status === "released") {
          logger.info("executor.step", {
            jobId: result.job.jobId,
            state: result.job.state,
            currentStep: result.job.currentStep,
            attempts: result.job.attempts,
          });
        }
        if (result.status === "fenced") {
          logger.warn("executor.fenced", { jobId: result.jobId, reason: result.reason });
        }
      } catch (error) {
        logger.error("executor.pass_failed", { error: describeError(error, redact) });
      }
      try {
        await delay(config.pollIntervalMs, undefined, { signal: stopSleep.signal });
      } catch {
        // Only shutdown aborts the pause.
      }
    }
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    // The logger may not exist yet; stderr is the only safe channel here.
    console.error(`alloc executor failed to start: ${describeError(error, redact).message}`);
    process.exitCode = 1;
  }
}

function faultHook(fault: ExecutorFault, target: string | null, logger: Logger): ExecutorHooks {
  if (fault !== "crash_after_provider_apply" || target === null) {
    return {};
  }
  return {
    afterDelivery: async (intent) => {
      if (intent.actionIntentId !== target) {
        return;
      }
      logger.warn("executor.crash_injected", { actionIntentId: intent.actionIntentId, state: intent.state });
      // Abrupt, uncatchable termination: the transaction that would persist the
      // receipt never runs, leaving the lease to expire.
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => undefined);
    },
  };
}

interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** One JSON object per line; `silent` suppresses everything. */
function createLogger(level: LogLevel): Logger {
  const write = (eventLevel: Exclude<LogLevel, "silent">) => (event: string, fields: Record<string, unknown> = {}): void => {
    if (level === "silent" || LEVEL_RANK[eventLevel] > LEVEL_RANK[level]) {
      return;
    }
    process.stdout.write(`${JSON.stringify({ level: eventLevel, time: new Date().toISOString(), event, ...fields })}\n`);
  };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`alloc executor failed to start: ${message}`);
  process.exit(1);
});
