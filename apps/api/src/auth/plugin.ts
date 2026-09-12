import type { FastifyInstance, FastifyRequest } from "fastify";
import { apiErrors } from "../errors.js";
import type { Principal } from "./principal.js";
import type { TokenVerifier } from "./verifier.js";

const BEARER_SCHEME = /^bearer\s+(\S+)$/i;

export function registerAuth(app: FastifyInstance, verify: TokenVerifier): void {
  app.decorateRequest("principal", null);

  app.decorate("authenticate", async (request: FastifyRequest): Promise<void> => {
    request.principal = await verify(bearerToken(request));
  });
}

/** Principal established by `authenticate`; routes must not read claims directly. */
export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) {
    throw new Error("route is missing the authenticate preHandler");
  }
  return request.principal;
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? BEARER_SCHEME.exec(header.trim()) : null;
  const token = match?.[1];
  if (!token || token.split(".").length !== 3) {
    throw apiErrors.unauthenticated();
  }
  return token;
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}
