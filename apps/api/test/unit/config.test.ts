import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_HEARTBEAT_FREQUENCY_MS,
  DEFAULT_HOST,
  DEFAULT_JWT_AUDIENCE,
  DEFAULT_JWT_ISSUER,
  DEFAULT_PORT,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  configSecrets,
  loadConfig,
  redactedConfig,
} from "../../src/config.js";

const REQUIRED_ENV = {
  MONGO_URI: "mongodb://127.0.0.1:27017/?replicaSet=alloc",
  MONGO_DATABASE: "alloc_config_test",
  JWT_SECRET: "configuration-test-secret-32-bytes-minimum",
};

describe("loadConfig", () => {
  it("applies documented defaults for optional settings", () => {
    const config = loadConfig({ ...REQUIRED_ENV });

    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.logLevel).toBe("info");
    expect(config.jwt.issuer).toBe(DEFAULT_JWT_ISSUER);
    expect(config.jwt.audience).toBe(DEFAULT_JWT_AUDIENCE);
    expect(config.shutdownTimeoutMs).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    expect(config.mongo.heartbeatFrequencyMs).toBe(DEFAULT_HEARTBEAT_FREQUENCY_MS);
    expect(config.mongo.serverSelectionTimeoutMs).toBe(5_000);
  });

  it("prefers CONDUCTOR_PORT over PORT", () => {
    expect(loadConfig({ ...REQUIRED_ENV, PORT: "4000", CONDUCTOR_PORT: "55070" }).port).toBe(55_070);
    expect(loadConfig({ ...REQUIRED_ENV, PORT: "4000" }).port).toBe(4_000);
    expect(loadConfig({ ...REQUIRED_ENV, PORT: "", CONDUCTOR_PORT: " " }).port).toBe(DEFAULT_PORT);
  });

  it("parses explicit settings", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      HOST: "0.0.0.0",
      PORT: "8080",
      LOG_LEVEL: "debug",
      MONGO_SERVER_SELECTION_TIMEOUT_MS: "1500",
      JWT_ISSUER: "alloc-issuer",
      JWT_AUDIENCE: "alloc-audience",
      SHUTDOWN_TIMEOUT_MS: "2500",
    });

    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 8_080,
      logLevel: "debug",
      shutdownTimeoutMs: 2_500,
      jwt: { issuer: "alloc-issuer", audience: "alloc-audience" },
      mongo: { serverSelectionTimeoutMs: 1_500, database: "alloc_config_test" },
    });
  });

  it("rejects missing required settings before startup", () => {
    expect(() => loadConfig({})).toThrowError(ConfigError);

    const missingAll = captureConfigError({});
    expect(missingAll.message).toContain("MONGO_URI is required");
    expect(missingAll.message).toContain("MONGO_DATABASE is required");
    expect(missingAll.message).toContain("JWT_SECRET must be at least 32 bytes");
  });

  it("rejects a JWT secret shorter than 32 bytes without echoing the value", () => {
    const secret = "too-short-secret";
    const error = captureConfigError({ ...REQUIRED_ENV, JWT_SECRET: secret });

    expect(error.message).toContain("JWT_SECRET must be at least 32 bytes for HS256");
    expect(error.message).not.toContain(secret);
  });

  it("rejects malformed values without echoing the offending input", () => {
    const error = captureConfigError({
      ...REQUIRED_ENV,
      MONGO_URI: "http://example.invalid:27017",
      MONGO_DATABASE: "bad database name",
      PORT: "not-a-port",
      LOG_LEVEL: "verbose",
      SHUTDOWN_TIMEOUT_MS: "5",
    });

    expect(error.issues).toHaveLength(5);
    expect(error.message).toContain("MONGO_URI must be a mongodb:// or mongodb+srv:// connection string");
    expect(error.message).toContain("MONGO_DATABASE must be a MongoDB database name");
    expect(error.message).toContain("PORT");
    expect(error.message).toContain("LOG_LEVEL");
    expect(error.message).toContain("SHUTDOWN_TIMEOUT_MS");
    expect(error.message).not.toContain("http://example.invalid:27017");
    expect(error.message).not.toContain("not-a-port");
  });

  it("keeps secrets out of the redacted configuration", () => {
    const sessionToken = "aws-session-secret";
    const certificatePassword = "certificate-secret";
    const proxyPassword = "proxy-secret";
    const config = loadConfig({
      ...REQUIRED_ENV,
      MONGO_URI:
        `mongodb://alloc_admin:hunter2@127.0.0.1:27017/?replicaSet=alloc` +
        `&authMechanismProperties=AWS_SESSION_TOKEN:${sessionToken}` +
        `&tlsCertificateKeyFilePassword=${certificatePassword}` +
        `&proxyUsername=proxy-user&proxyPassword=${proxyPassword}`,
    });

    const serialized = JSON.stringify(redactedConfig(config));
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain(sessionToken);
    expect(serialized).not.toContain(certificatePassword);
    expect(serialized).not.toContain("proxy-user");
    expect(serialized).not.toContain(proxyPassword);
    expect(serialized).not.toContain(config.jwt.secret);
    expect(serialized).toContain("[redacted]");
    expect(configSecrets(config)).toEqual([config.jwt.secret, config.mongo.uri]);
  });
});

function captureConfigError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected loadConfig to reject the configuration");
}
