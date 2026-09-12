import { z } from "zod";
import { redactMongoUri, redactText } from "./redact.js";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** HS256 requires a key at least as long as the digest output. */
export const MIN_JWT_SECRET_BYTES = 32;

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;
export const DEFAULT_LOG_LEVEL: LogLevel = "info";
export const DEFAULT_JWT_ISSUER = "alloc-local";
export const DEFAULT_JWT_AUDIENCE = "alloc-api";
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 5_000;
export const DEFAULT_HEARTBEAT_FREQUENCY_MS = 10_000;

export interface MongoConfig {
  readonly uri: string;
  readonly database: string;
  readonly serverSelectionTimeoutMs: number;
  readonly heartbeatFrequencyMs: number;
}

export interface JwtConfig {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
}

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly mongo: MongoConfig;
  readonly jwt: JwtConfig;
  readonly shutdownTimeoutMs: number;
}

/** Raised before the process listens when configuration is missing or malformed. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(readonly issues: readonly string[]) {
    super(`Invalid application configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
  }
}

const MONGO_URI_PATTERN = /^mongodb(?:\+srv)?:\/\/[^\s]+$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PortSchema = z.coerce.number().int().min(1).max(65_535);

/** Shared configuration fragments; process entrypoints compose their own schema. */
export const LOG_LEVEL_SCHEMA = z.enum(LOG_LEVELS).describe("LOG_LEVEL");
export const MONGO_URI_SCHEMA = z
  .string()
  .min(1, "is required")
  .regex(MONGO_URI_PATTERN, "must be a mongodb:// or mongodb+srv:// connection string")
  .describe("MONGO_URI");
export const MONGO_DATABASE_SCHEMA = z
  .string()
  .min(1, "is required")
  .regex(DATABASE_NAME_PATTERN, "must be a MongoDB database name without spaces or / \\. \" $ * < > : | ?")
  .describe("MONGO_DATABASE");
export const DURATION_SCHEMA = z.coerce.number().int().min(100).max(600_000);

const RawConfigSchema = z.object({
  host: z.string().min(1).max(255).describe("HOST"),
  port: PortSchema.describe("PORT"),
  logLevel: LOG_LEVEL_SCHEMA,
  mongoUri: MONGO_URI_SCHEMA,
  mongoDatabase: MONGO_DATABASE_SCHEMA,
  mongoServerSelectionTimeoutMs: DURATION_SCHEMA.describe("MONGO_SERVER_SELECTION_TIMEOUT_MS"),
  mongoHeartbeatFrequencyMs: DURATION_SCHEMA.describe("MONGO_HEARTBEAT_FREQUENCY_MS"),
  jwtSecret: z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, "utf8") >= MIN_JWT_SECRET_BYTES,
      `must be at least ${MIN_JWT_SECRET_BYTES} bytes for HS256`,
    )
    .describe("JWT_SECRET"),
  jwtIssuer: z.string().min(1, "is required").max(256).describe("JWT_ISSUER"),
  jwtAudience: z.string().min(1, "is required").max(256).describe("JWT_AUDIENCE"),
  shutdownTimeoutMs: DURATION_SCHEMA.describe("SHUTDOWN_TIMEOUT_MS"),
});

type RawConfigKey = keyof z.infer<typeof RawConfigSchema>;

const ENV_NAMES: Record<RawConfigKey, string> = {
  host: "HOST",
  port: "PORT",
  logLevel: "LOG_LEVEL",
  mongoUri: "MONGO_URI",
  mongoDatabase: "MONGO_DATABASE",
  mongoServerSelectionTimeoutMs: "MONGO_SERVER_SELECTION_TIMEOUT_MS",
  mongoHeartbeatFrequencyMs: "MONGO_HEARTBEAT_FREQUENCY_MS",
  jwtSecret: "JWT_SECRET",
  jwtIssuer: "JWT_ISSUER",
  jwtAudience: "JWT_AUDIENCE",
  shutdownTimeoutMs: "SHUTDOWN_TIMEOUT_MS",
};

/**
 * Reads and validates startup configuration. Nothing is defaulted for the
 * MongoDB connection, database, or JWT secret: a missing value is a startup
 * failure. `CONDUCTOR_PORT` takes precedence over `PORT` when present.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const raw = {
    host: readEnv(env, "HOST") ?? DEFAULT_HOST,
    port: readEnv(env, "CONDUCTOR_PORT") ?? readEnv(env, "PORT") ?? DEFAULT_PORT,
    logLevel: readEnv(env, "LOG_LEVEL") ?? DEFAULT_LOG_LEVEL,
    mongoUri: readEnv(env, "MONGO_URI") ?? "",
    mongoDatabase: readEnv(env, "MONGO_DATABASE") ?? "",
    mongoServerSelectionTimeoutMs: readEnv(env, "MONGO_SERVER_SELECTION_TIMEOUT_MS") ?? DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
    mongoHeartbeatFrequencyMs: readEnv(env, "MONGO_HEARTBEAT_FREQUENCY_MS") ?? DEFAULT_HEARTBEAT_FREQUENCY_MS,
    jwtSecret: readEnv(env, "JWT_SECRET") ?? "",
    jwtIssuer: readEnv(env, "JWT_ISSUER") ?? DEFAULT_JWT_ISSUER,
    jwtAudience: readEnv(env, "JWT_AUDIENCE") ?? DEFAULT_JWT_AUDIENCE,
    shutdownTimeoutMs: readEnv(env, "SHUTDOWN_TIMEOUT_MS") ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
  };

  const parsed = RawConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(configIssues(parsed.error, [raw.jwtSecret, raw.mongoUri], ENV_NAMES));
  }

  const config = parsed.data;
  return {
    host: config.host,
    port: config.port,
    logLevel: config.logLevel,
    mongo: {
      uri: config.mongoUri,
      database: config.mongoDatabase,
      serverSelectionTimeoutMs: config.mongoServerSelectionTimeoutMs,
      heartbeatFrequencyMs: config.mongoHeartbeatFrequencyMs,
    },
    jwt: {
      secret: config.jwtSecret,
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    },
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  };
}

/** Secret values that must never reach logs, responses, or error messages. */
export function configSecrets(config: AppConfig): readonly string[] {
  return [config.jwt.secret, config.mongo.uri];
}

/** JSON-safe view of the configuration with credentials and secrets removed. */
export function redactedConfig(config: AppConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    logLevel: config.logLevel,
    mongo: {
      uri: redactMongoUri(config.mongo.uri),
      database: config.mongo.database,
      serverSelectionTimeoutMs: config.mongo.serverSelectionTimeoutMs,
      heartbeatFrequencyMs: config.mongo.heartbeatFrequencyMs,
    },
    jwt: {
      secret: "[redacted]",
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    },
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  };
}

/** Reads a variable, treating an empty or blank value as absent. */
export function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/**
 * Formats validation issues as `ENV_NAME message`, redacting every secret so a
 * rejected value never reaches a log or an operator's terminal.
 */
export function configIssues(
  error: z.ZodError,
  secrets: readonly string[],
  names: Record<string, string>,
): readonly string[] {
  return error.issues.map((issue) => {
    const key = issue.path.join(".");
    const name = names[key] ?? (key.length > 0 ? key : "(configuration)");
    return `${name} ${redactText(issue.message, secrets)}`;
  });
}
