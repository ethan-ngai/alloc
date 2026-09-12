/**
 * Startup configuration for the executor process. It shares the MongoDB and log
 * fragments with the API so both processes agree on connection and timeout
 * semantics, and adds only the executor's own knobs. Nothing is defaulted for
 * the connection: a missing URI or database is a startup failure.
 */
import { IdSchema } from "@alloc/contracts";
import { z } from "zod";
import {
  ConfigError,
  DURATION_SCHEMA, LOG_LEVEL_SCHEMA, MONGO_DATABASE_SCHEMA, MONGO_URI_SCHEMA,
  configIssues, readEnv, type LogLevel, type MongoConfig,
} from "../config.js";
import { SIMULATED_FAILURE_MODES, type SimulatedFailureMode } from "./provider.js";

export const DEFAULT_EXECUTOR_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_EXECUTOR_BATCH_SIZE = 10;
/**
 * A step that outlives its lease is fenced, not overwritten, so this is the
 * bound on one delivery attempt rather than a promise about the provider.
 */
export const DEFAULT_EXECUTOR_LEASE_MS = 30_000;

/**
 * `crash_after_provider_apply` kills the process after the provider applied the
 * operation, but only for the intent named by `EXECUTOR_FAULT_TARGET`. The
 * target is mandatory: a whole process that kills itself on arrival is a crash
 * loop with no progress, so activation has to name the one intent under test.
 */
export const EXECUTOR_FAULTS = ["none", "crash_after_provider_apply"] as const;
export type ExecutorFault = (typeof EXECUTOR_FAULTS)[number];

export interface ExecutorConfig {
  readonly logLevel: LogLevel;
  readonly mongo: MongoConfig;
  readonly shutdownTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly leaseDurationMs: number;
  readonly fault: ExecutorFault;
  /** Intent the fault applies to; required whenever `fault` is not `none`. */
  readonly faultTarget: string | null;
  readonly providerFailureMode: SimulatedFailureMode;
}

const RawExecutorConfigSchema = z.object({
  logLevel: LOG_LEVEL_SCHEMA,
  mongoUri: MONGO_URI_SCHEMA,
  mongoDatabase: MONGO_DATABASE_SCHEMA,
  mongoServerSelectionTimeoutMs: DURATION_SCHEMA.describe("MONGO_SERVER_SELECTION_TIMEOUT_MS"),
  mongoHeartbeatFrequencyMs: DURATION_SCHEMA.describe("MONGO_HEARTBEAT_FREQUENCY_MS"),
  shutdownTimeoutMs: DURATION_SCHEMA.describe("SHUTDOWN_TIMEOUT_MS"),
  pollIntervalMs: z.coerce.number().int().min(100).max(60_000).describe("EXECUTOR_POLL_INTERVAL_MS"),
  batchSize: z.coerce.number().int().min(1).max(100).describe("EXECUTOR_BATCH_SIZE"),
  leaseDurationMs: z.coerce.number().int().min(1_000).max(600_000).describe("EXECUTOR_LEASE_MS"),
  fault: z.enum(EXECUTOR_FAULTS).describe("EXECUTOR_FAULT"),
  faultTarget: IdSchema.nullable().describe("EXECUTOR_FAULT_TARGET"),
  providerFailureMode: z.enum(SIMULATED_FAILURE_MODES).describe("SIMULATED_PROVIDER_FAILURE_MODE"),
}).superRefine((config, context) => {
  if (config.fault !== "none" && config.faultTarget === null) {
    context.addIssue({
      code: "custom",
      path: ["faultTarget"],
      message: "is required when EXECUTOR_FAULT is set",
    });
  }
});

type RawExecutorConfigKey = keyof z.infer<typeof RawExecutorConfigSchema>;

const ENV_NAMES: Record<RawExecutorConfigKey, string> = {
  logLevel: "LOG_LEVEL",
  mongoUri: "MONGO_URI",
  mongoDatabase: "MONGO_DATABASE",
  mongoServerSelectionTimeoutMs: "MONGO_SERVER_SELECTION_TIMEOUT_MS",
  mongoHeartbeatFrequencyMs: "MONGO_HEARTBEAT_FREQUENCY_MS",
  shutdownTimeoutMs: "SHUTDOWN_TIMEOUT_MS",
  pollIntervalMs: "EXECUTOR_POLL_INTERVAL_MS",
  batchSize: "EXECUTOR_BATCH_SIZE",
  leaseDurationMs: "EXECUTOR_LEASE_MS",
  fault: "EXECUTOR_FAULT",
  faultTarget: "EXECUTOR_FAULT_TARGET",
  providerFailureMode: "SIMULATED_PROVIDER_FAILURE_MODE",
};

export function loadExecutorConfig(env: Record<string, string | undefined> = process.env): ExecutorConfig {
  const raw = {
    logLevel: readEnv(env, "LOG_LEVEL") ?? "info",
    mongoUri: readEnv(env, "MONGO_URI") ?? "",
    mongoDatabase: readEnv(env, "MONGO_DATABASE") ?? "",
    mongoServerSelectionTimeoutMs: readEnv(env, "MONGO_SERVER_SELECTION_TIMEOUT_MS") ?? "5000",
    mongoHeartbeatFrequencyMs: readEnv(env, "MONGO_HEARTBEAT_FREQUENCY_MS") ?? "10000",
    shutdownTimeoutMs: readEnv(env, "SHUTDOWN_TIMEOUT_MS") ?? "10000",
    pollIntervalMs: readEnv(env, "EXECUTOR_POLL_INTERVAL_MS") ?? String(DEFAULT_EXECUTOR_POLL_INTERVAL_MS),
    batchSize: readEnv(env, "EXECUTOR_BATCH_SIZE") ?? String(DEFAULT_EXECUTOR_BATCH_SIZE),
    leaseDurationMs: readEnv(env, "EXECUTOR_LEASE_MS") ?? String(DEFAULT_EXECUTOR_LEASE_MS),
    fault: readEnv(env, "EXECUTOR_FAULT") ?? "none",
    faultTarget: readEnv(env, "EXECUTOR_FAULT_TARGET") ?? null,
    providerFailureMode: readEnv(env, "SIMULATED_PROVIDER_FAILURE_MODE") ?? "none",
  };

  const parsed = RawExecutorConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(configIssues(parsed.error, [raw.mongoUri], ENV_NAMES));
  }
  const config = parsed.data;
  return {
    logLevel: config.logLevel,
    mongo: {
      uri: config.mongoUri,
      database: config.mongoDatabase,
      serverSelectionTimeoutMs: config.mongoServerSelectionTimeoutMs,
      heartbeatFrequencyMs: config.mongoHeartbeatFrequencyMs,
    },
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    batchSize: config.batchSize,
    leaseDurationMs: config.leaseDurationMs,
    fault: config.fault,
    faultTarget: config.faultTarget,
    providerFailureMode: config.providerFailureMode,
  };
}
