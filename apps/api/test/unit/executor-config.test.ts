import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config.js";
import {
  DEFAULT_EXECUTOR_BATCH_SIZE, DEFAULT_EXECUTOR_LEASE_MS, DEFAULT_EXECUTOR_POLL_INTERVAL_MS, loadExecutorConfig,
} from "../../src/execution/config.js";

const REQUIRED_ENV = {
  MONGO_URI: "mongodb://127.0.0.1:27017/?replicaSet=alloc",
  MONGO_DATABASE: "alloc_executor_test",
};

describe("loadExecutorConfig", () => {
  it("applies documented defaults for the executor knobs", () => {
    const config = loadExecutorConfig({ ...REQUIRED_ENV });

    expect(config.pollIntervalMs).toBe(DEFAULT_EXECUTOR_POLL_INTERVAL_MS);
    expect(config.batchSize).toBe(DEFAULT_EXECUTOR_BATCH_SIZE);
    expect(config.leaseDurationMs).toBe(DEFAULT_EXECUTOR_LEASE_MS);
    expect(config.fault).toBe("none");
    expect(config.faultTarget).toBeNull();
    expect(config.providerFailureMode).toBe("none");
    expect(config.logLevel).toBe("info");
    expect(config.mongo.heartbeatFrequencyMs).toBe(10_000);
    expect(config.mongo.serverSelectionTimeoutMs).toBe(5_000);
  });

  it("parses explicit settings and treats blank values as absent", () => {
    const config = loadExecutorConfig({
      ...REQUIRED_ENV,
      LOG_LEVEL: "debug",
      MONGO_SERVER_SELECTION_TIMEOUT_MS: "1500",
      SHUTDOWN_TIMEOUT_MS: "2500",
      EXECUTOR_POLL_INTERVAL_MS: "250",
      EXECUTOR_BATCH_SIZE: "3",
      EXECUTOR_LEASE_MS: "1500",
      EXECUTOR_FAULT: "crash_after_provider_apply",
      EXECUTOR_FAULT_TARGET: "action_0123456789abcdef01234567",
      SIMULATED_PROVIDER_FAILURE_MODE: "timeout_after_apply",
    });

    expect(config).toMatchObject({
      logLevel: "debug",
      shutdownTimeoutMs: 2_500,
      pollIntervalMs: 250,
      batchSize: 3,
      leaseDurationMs: 1_500,
      fault: "crash_after_provider_apply",
      faultTarget: "action_0123456789abcdef01234567",
      providerFailureMode: "timeout_after_apply",
      mongo: { serverSelectionTimeoutMs: 1_500, database: "alloc_executor_test" },
    });

    expect(loadExecutorConfig({ ...REQUIRED_ENV, EXECUTOR_FAULT: " ", SIMULATED_PROVIDER_FAILURE_MODE: "" })).toMatchObject({
      fault: "none",
      faultTarget: null,
      providerFailureMode: "none",
    });
  });

  it("refuses a fault that names no intent, before the process can crash-loop", () => {
    expect(() => loadExecutorConfig({ ...REQUIRED_ENV, EXECUTOR_FAULT: "crash_after_provider_apply" })).toThrowError(ConfigError);

    const missing = captureConfigError({ ...REQUIRED_ENV, EXECUTOR_FAULT: "crash_after_provider_apply" });
    expect(missing.message).toContain("EXECUTOR_FAULT_TARGET is required when EXECUTOR_FAULT is set");

    const malformed = captureConfigError({
      ...REQUIRED_ENV,
      EXECUTOR_FAULT: "crash_after_provider_apply",
      EXECUTOR_FAULT_TARGET: "not-an-id",
    });
    expect(malformed.message).toContain("EXECUTOR_FAULT_TARGET expected a stable prefixed ID");
    expect(loadExecutorConfig({
      ...REQUIRED_ENV,
      EXECUTOR_FAULT: "crash_after_provider_apply",
      EXECUTOR_FAULT_TARGET: "action_0123456789abcdef01234567",
    }).faultTarget).toBe("action_0123456789abcdef01234567");
  });

  it("refuses to start without a connection and database", () => {
    expect(() => loadExecutorConfig({})).toThrowError(ConfigError);

    const error = captureConfigError({});
    expect(error.message).toContain("MONGO_URI is required");
    expect(error.message).toContain("MONGO_DATABASE is required");
  });

  it("rejects unknown failure modes and malformed knobs without echoing the connection string", () => {
    const error = captureConfigError({
      ...REQUIRED_ENV,
      MONGO_URI: "mongodb://alloc:hunter2@127.0.0.1:27017/?replicaSet=alloc",
      EXECUTOR_FAULT: "crash_whenever",
      SIMULATED_PROVIDER_FAILURE_MODE: "explode",
      EXECUTOR_POLL_INTERVAL_MS: "1",
      EXECUTOR_BATCH_SIZE: "0",
    });

    expect(error.message).toContain("EXECUTOR_FAULT");
    expect(error.message).toContain("SIMULATED_PROVIDER_FAILURE_MODE");
    expect(error.message).toContain("EXECUTOR_POLL_INTERVAL_MS");
    expect(error.message).toContain("EXECUTOR_BATCH_SIZE");
    expect(error.message).not.toContain("hunter2");
  });
});

function captureConfigError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadExecutorConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected loadExecutorConfig to reject the configuration");
}
