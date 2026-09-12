import { buildApp } from "./app.js";
import { configSecrets, loadConfig, redactedConfig } from "./config.js";
import { describeError } from "./errors.js";
import { connectMongoRuntime, type MongoRuntime } from "./mongo/runtime.js";
import { redactText } from "./redact.js";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Process entrypoint: loads configuration, refuses unusable dependencies,
 * listens, and owns graceful shutdown. Tests import `buildApp` instead.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const redact = (text: string): string => redactText(text, configSecrets(config));
  let runtime: MongoRuntime | undefined;

  try {
    runtime = await connectMongoRuntime({
      uri: config.mongo.uri,
      database: config.mongo.database,
      serverSelectionTimeoutMs: config.mongo.serverSelectionTimeoutMs,
      heartbeatFrequencyMs: config.mongo.heartbeatFrequencyMs,
    });

    const app = buildApp({
      config,
      readiness: runtime.readiness,
      organizations: runtime.organizations,
      imports: runtime.imports,
      finance: runtime.finance,
    });

    let shuttingDown = false;
    const shutdown = async (reason: string): Promise<void> => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      runtime?.readiness.markNotReady(reason);

      const deadline = setTimeout(() => {
        app.log.error({ reason, timeoutMs: config.shutdownTimeoutMs }, "graceful shutdown timed out");
        process.exit(1);
      }, config.shutdownTimeoutMs);
      deadline.unref();

      try {
        await app.close();
        await runtime?.close();
        clearTimeout(deadline);
        process.exit(0);
      } catch (error) {
        clearTimeout(deadline);
        app.log.error({ err: describeError(error, redact), reason }, "shutdown failed");
        process.exit(1);
      }
    };

    for (const signal of SHUTDOWN_SIGNALS) {
      process.on(signal, () => {
        void shutdown(`${signal} received`);
      });
    }
    process.on("uncaughtException", (error) => {
      app.log.error({ err: describeError(error, redact) }, "uncaught exception");
      void shutdown("uncaught exception");
    });
    process.on("unhandledRejection", (reason) => {
      app.log.error({ err: describeError(reason, redact) }, "unhandled rejection");
      void shutdown("unhandled rejection");
    });

    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      {
        host: config.host,
        port: config.port,
        mongo: redactedConfig(config)["mongo"],
        topology: runtime.topology,
      },
      "alloc api listening",
    );
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    const described = describeError(error, redact);
    // The logger may not exist yet; stderr is the only safe channel here.
    console.error(`alloc api failed to start: ${described.name}: ${described.message}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`alloc api failed to start: ${redactText(message)}`);
  process.exit(1);
});
