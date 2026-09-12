/**
 * Executor worker process.
 *
 * It connects to the same MongoDB replica set as the API, installs the executor
 * collections, and repeatedly runs one bounded dispatch/reconcile pass. The
 * loop is an interim single-flight poller: task 5A's scheduler owns leases and
 * retry budgets and will drive `MongoActionExecutor` per leased job. The pass
 * itself is already duplicate-safe, because claiming is a compare-and-swap and
 * the provider is idempotent per delivery key.
 *
 * `EXECUTOR_FAULT=crash_after_provider_apply` kills the process between the
 * provider side effect and the receipt write. It exists so the restart and
 * reconciliation path can be exercised deterministically end to end.
 */
import { setTimeout as delay } from "node:timers/promises";
import { type LogLevel } from "../config.js";
import { describeError } from "../errors.js";
import { connectMongoRuntime, type MongoRuntime } from "../mongo/runtime.js";
import { redactText } from "../redact.js";
import { loadExecutorConfig } from "./config.js";
import { MongoActionExecutor, type ExecutionSweep, type ExecutorHooks } from "./executor.js";
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
    const executor = new MongoActionExecutor(
      runtime.db,
      runtime.withTransaction,
      new SimulatedSpendProvider(runtime.db, { failureMode: config.providerFailureMode }),
      () => new Date(),
      faultHook(config.fault, logger),
    );

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
      fault: config.fault,
      providerFailureMode: config.providerFailureMode,
    });

    while (!stopping) {
      try {
        const sweep = await executor.runOnce({ limit: config.batchSize });
        if (!sweep.idle) {
          logger.info("executor.sweep", { results: summarize(sweep) });
        }
      } catch (error) {
        logger.error("executor.sweep_failed", { error: describeError(error, redact) });
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

function faultHook(fault: string, logger: Logger): ExecutorHooks {
  if (fault !== "crash_after_provider_apply") {
    return {};
  }
  return {
    afterDelivery: async (intent) => {
      logger.warn("executor.crash_injected", { actionIntentId: intent.actionIntentId, state: intent.state });
      // Abrupt, uncatchable termination: the transaction that would persist the
      // receipt never runs.
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => undefined);
    },
  };
}

function summarize(sweep: ExecutionSweep): Array<{ actionIntentId: string; status: string }> {
  return sweep.results.map((result) => ({
    actionIntentId: result.status === "missing" ? "unknown" : result.intent.actionIntentId,
    status: result.status,
  }));
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
