import type { CompanyEntity } from "@alloc/contracts";
import type { FastifyInstance } from "fastify";
import { type JWTPayload, SignJWT } from "jose";
import { buildApp } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import type { OrganizationRepository } from "../../src/mongo/organizations.js";
import type { ImportRepository } from "../../src/imports/repository.js";
import type { ContextRepository } from "../../src/context/repository.js";
import type { GraphRepository } from "../../src/context/graph.js";
import { createReadiness, type Readiness } from "../../src/readiness.js";
import { northstarOrganization } from "./organizations.js";

export const TEST_JWT_SECRET = "unit-test-jwt-secret-with-at-least-32-bytes";
export const TEST_JWT_ISSUER = "alloc-test-issuer";
export const TEST_JWT_AUDIENCE = "alloc-test-audience";

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({
    MONGO_URI: "mongodb://127.0.0.1:27017/?replicaSet=alloc",
    MONGO_DATABASE: "alloc_unit_test",
    JWT_SECRET: TEST_JWT_SECRET,
    JWT_ISSUER: TEST_JWT_ISSUER,
    JWT_AUDIENCE: TEST_JWT_AUDIENCE,
    ...overrides,
  });
}

export interface SignTokenOptions {
  readonly secret?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly algorithm?: "HS256" | "HS512";
  readonly expiresInSeconds?: number;
  readonly withExpiration?: boolean;
  /** Overrides merged over the default claims; `undefined` removes a claim. */
  readonly claims?: Record<string, unknown>;
}

export async function signTestToken(options: SignTokenOptions = {}): Promise<string> {
  const claims = mergeClaims(
    { sub: "user_jd", org: northstarOrganization.organizationId, roles: ["approver"] },
    options.claims ?? {},
  );
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = new SignJWT(claims)
    .setProtectedHeader({ alg: options.algorithm ?? "HS256" })
    .setIssuer(options.issuer ?? TEST_JWT_ISSUER)
    .setAudience(options.audience ?? TEST_JWT_AUDIENCE)
    .setIssuedAt(issuedAt);

  if (options.withExpiration ?? true) {
    token.setExpirationTime(issuedAt + (options.expiresInSeconds ?? 300));
  }
  return token.sign(new TextEncoder().encode(options.secret ?? TEST_JWT_SECRET));
}

/** Repository double that records every tenant it was asked for. */
export interface RecordingRepository extends OrganizationRepository {
  readonly requestedIds: string[];
}

export function recordingRepository(organizations: readonly CompanyEntity[]): RecordingRepository {
  const requestedIds: string[] = [];
  return {
    requestedIds,
    async findById(organizationId: string): Promise<CompanyEntity | null> {
      requestedIds.push(organizationId);
      return organizations.find((organization) => organization.organizationId === organizationId) ?? null;
    },
  };
}

export function mergeClaims(base: JWTPayload, overrides: Record<string, unknown>): JWTPayload {
  const merged: JWTPayload = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function readyReadiness(): Readiness {
  const readiness = createReadiness();
  readiness.markReady();
  return readiness;
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly config: AppConfig;
  readonly readiness: Readiness;
  readonly organizations: OrganizationRepository;
}

const noImports: ImportRepository = {
  async ingest() { throw new Error("imports are not configured for this test"); },
  async listPostings() { return []; },
  async seedEntities() {},
  async seedMappings() {},
};
const noContext: ContextRepository = { async query() { throw new Error("context is not configured for this test"); } };
const noGraph: GraphRepository = { async query() { throw new Error("graph is not configured for this test"); }, async seedRelationships() {} };

export function buildTestApp(options: {
  config?: AppConfig;
  readiness?: Readiness;
  organizations?: OrganizationRepository;
  imports?: ImportRepository;
  context?: ContextRepository;
  graph?: GraphRepository;
} = {}): TestApp {
  const config = options.config ?? testConfig();
  const readiness = options.readiness ?? readyReadiness();
  const organizations = options.organizations ?? recordingRepository([northstarOrganization]);
  // Logging is disabled: tests assert on responses, not stdout.
  const app = buildApp({ config, readiness, organizations, imports: options.imports ?? noImports, context: options.context ?? noContext, graph: options.graph ?? noGraph, logger: false });
  return { app, config, readiness, organizations };
}
