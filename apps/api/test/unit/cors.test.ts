import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../support/app.js";

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("browser development origins", () => {
  it("permits loopback frontend preflights for authenticated imports", async () => {
    const { app } = buildTestApp();
    apps.push(app);
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/organizations/org_northstar/imports",
      headers: {
        origin: "http://localhost:55092",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:55092");
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    expect(response.headers["access-control-allow-headers"]).toContain("authorization");
  });

  it("does not grant CORS access to a non-loopback origin", async () => {
    const { app } = buildTestApp();
    apps.push(app);
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/organizations/org_northstar/imports",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
      },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
