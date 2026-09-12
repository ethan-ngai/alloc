import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp, signTestToken, TEST_JWT_AUDIENCE, TEST_JWT_ISSUER } from "../support/app.js";
import { NORTHSTAR_ORGANIZATION_ID } from "../support/organizations.js";

const ORGANIZATION_URL = `/v1/organizations/${NORTHSTAR_ORGANIZATION_ID}`;
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("bearer authentication", () => {
  it("accepts a valid HS256 token and derives tenant identity from claims", async () => {
    const app = newTestApp();
    const response = await app.inject({
      method: "GET",
      url: ORGANIZATION_URL,
      headers: { authorization: `Bearer ${await signTestToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, data: { organizationId: NORTHSTAR_ORGANIZATION_ID } });
  });

  it("rejects requests without a bearer token", async () => {
    const app = newTestApp();
    const response = await app.inject({ method: "GET", url: ORGANIZATION_URL });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "ACCESS_DENIED", message: "Authentication required", retryable: false },
    });
  });

  it.each([
    ["a non-bearer scheme", { authorization: "Basic dXNlcjpwYXNz" }],
    ["a bearer header without a token", { authorization: "Bearer " }],
    ["a token that is not a JWT", { authorization: "Bearer not-a-jwt" }],
    ["an unsigned alg=none token", { authorization: `Bearer ${unsignedToken()}` }],
  ])("rejects %s", async (_case, headers) => {
    const app = newTestApp();
    const response = await app.inject({ method: "GET", url: ORGANIZATION_URL, headers });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("ACCESS_DENIED");
  });

  it("rejects a token signed with another secret", async () => {
    const app = newTestApp();
    const token = await signTestToken({ secret: "a-different-secret-that-is-long-enough" });
    const response = await app.inject({
      method: "GET",
      url: ORGANIZATION_URL,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a token signed with a different algorithm", async () => {
    const app = newTestApp();
    const token = await signTestToken({ algorithm: "HS512" });
    const response = await app.inject({
      method: "GET",
      url: ORGANIZATION_URL,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects an expired token", async () => {
    const app = newTestApp();
    const token = await signTestToken({ expiresInSeconds: -60 });
    const response = await app.inject({
      method: "GET",
      url: ORGANIZATION_URL,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a token without an expiry claim", async () => {
    const app = newTestApp();
    const token = await signTestToken({ withExpiration: false });
    const response = await app.inject({
      method: "GET",
      url: ORGANIZATION_URL,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it("accepts the configured issuer and audience", async () => {
    const app = newTestApp();
    const token = await signTestToken({ issuer: TEST_JWT_ISSUER, audience: TEST_JWT_AUDIENCE });
    const response = await app.inject({
      method: "GET",
      url: ORGANIZATION_URL,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects a token from another issuer", async () => {
    const app = newTestApp();
    const wrongIssuer = await signTestToken({ issuer: "someone-else" });
    expect(
      (
        await app.inject({
          method: "GET",
          url: ORGANIZATION_URL,
          headers: { authorization: `Bearer ${wrongIssuer}` },
        })
      ).statusCode,
    ).toBe(401);

    const wrongAudience = await signTestToken({ audience: "another-api" });
    expect(
      (
        await app.inject({
          method: "GET",
          url: ORGANIZATION_URL,
          headers: { authorization: `Bearer ${wrongAudience}` },
        })
      ).statusCode,
    ).toBe(401);
  });

  it.each([
    ["a non-contract principal ID", { sub: "not-an-id" }],
    ["a missing principal ID", { sub: undefined }],
    ["a non-organization organization claim", { org: "northstar" }],
    ["a missing organization claim", { org: undefined }],
    ["an empty roles array", { roles: [] }],
    ["roles that are not strings", { roles: [42] }],
    ["a missing roles claim", { roles: undefined }],
  ])("rejects malformed claims: %s", async (_case, claims) => {
    const app = newTestApp();
    const token = await signTestToken({ claims });
    const response = await app.inject({
      method: "GET",
      url: ORGANIZATION_URL,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("ACCESS_DENIED");
  });

  it("never echoes the bearer token or verifier detail", async () => {
    const app = newTestApp();
    const token = await signTestToken({ secret: "a-different-secret-that-is-long-enough" });
    const response = await app.inject({
      method: "GET",
      url: ORGANIZATION_URL,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain("signature");
    expect(response.body).not.toContain("JWSSignatureVerificationFailed");
  });
});

function newTestApp(): FastifyInstance {
  const { app } = buildTestApp();
  apps.push(app);
  return app;
}

function unsignedToken(): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { sub: "user_jd", org: NORTHSTAR_ORGANIZATION_ID, roles: ["approver"] };
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
}
