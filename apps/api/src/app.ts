import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { registerAuth } from "./auth/plugin.js";
import { createTokenVerifier, type TokenVerifier } from "./auth/verifier.js";
import { configSecrets, type AppConfig } from "./config.js";
import { CORRELATION_ID_HEADER, correlationIdOf, resolveCorrelationId } from "./correlation.js";
import { apiErrors, describeError, errorEnvelope, toApiError } from "./errors.js";
import type { OrganizationRepository } from "./mongo/organizations.js";
import type { ImportRepository } from "./imports/repository.js";
import { registerImportRoutes } from "./routes/imports.js";
import type { ContextRepository } from "./context/repository.js";
import { registerContextRoutes } from "./routes/context.js";
import { redactText } from "./redact.js";
import type { Readiness } from "./readiness.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerOrganizationRoutes } from "./routes/organizations.js";

const REDACT_PATHS = ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"];

export interface AppDependencies {
  readonly config: AppConfig;
  readonly readiness: Readiness;
  readonly organizations: OrganizationRepository;
  readonly imports: ImportRepository;
  readonly context: ContextRepository;
  /** Overridden in tests; defaults to the configured HS256 verifier. */
  readonly verifier?: TokenVerifier;
  /** Fastify logger options; pass `false` to silence logs in tests. */
  readonly logger?: FastifyServerOptions["logger"];
}

/**
 * Composes the HTTP application without binding a socket, so tests can inject
 * requests and the process entrypoint can own listening and shutdown.
 */
export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? {
      level: deps.config.logLevel,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    },
    bodyLimit: 1_048_576,
    trustProxy: false,
  });
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_request, body, done) => done(null, body));
  const redact = (text: string): string => redactText(text, configSecrets(deps.config));

  app.addHook("onRequest", async (request, reply) => {
    const correlationId = resolveCorrelationId(request.headers[CORRELATION_ID_HEADER]);
    request.correlationId = correlationId;
    reply.header(CORRELATION_ID_HEADER, correlationId);
    reply.header("cache-control", "no-store");
  });

  registerAuth(app, deps.verifier ?? createTokenVerifier(deps.config.jwt));
  registerHealthRoutes(app, deps.readiness);
  registerOrganizationRoutes(app, deps.organizations);
  registerImportRoutes(app, deps.imports);
  registerContextRoutes(app, deps.context);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404);
    return errorEnvelope(correlationIdOf(request), apiErrors.notFound("Route not found"));
  });

  app.setErrorHandler((error, request, reply) => {
    const correlationId = correlationIdOf(request);
    const apiError = toApiError(error);
    if (apiError.statusCode >= 500) {
      request.log.error({ correlationId, err: describeError(error, redact) }, "request failed");
    } else {
      request.log.warn(
        { correlationId, statusCode: apiError.statusCode, code: apiError.code },
        "request rejected",
      );
    }
    reply.code(apiError.statusCode);
    return errorEnvelope(correlationId, apiError);
  });

  return app;
}
