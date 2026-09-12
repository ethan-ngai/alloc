import { IdSchema } from "@alloc/contracts";
import { describe, expect, it } from "vitest";
import { CORRELATION_ID_HEADER, correlationIdOf, generateCorrelationId, resolveCorrelationId } from "../../src/correlation.js";
import { buildTestApp } from "../support/app.js";

describe("correlation IDs", () => {
  it("generates unique IDs that satisfy the shared IdSchema", () => {
    const generated = new Set(Array.from({ length: 50 }, () => generateCorrelationId()));

    expect(generated.size).toBe(50);
    for (const correlationId of generated) {
      expect(IdSchema.safeParse(correlationId).success).toBe(true);
      expect(correlationId.startsWith("corr_")).toBe(true);
    }
  });

  it("reuses a valid caller-supplied ID and replaces anything else", () => {
    expect(resolveCorrelationId("corr_client_provided")).toBe("corr_client_provided");
    expect(IdSchema.safeParse(resolveCorrelationId("not a valid id")).success).toBe(true);
    expect(resolveCorrelationId("not a valid id")).not.toBe("not a valid id");
    expect(IdSchema.safeParse(resolveCorrelationId(["corr_first", "corr_second"])).success).toBe(true);
    expect(resolveCorrelationId(undefined)).toMatch(/^corr_[0-9a-f]{32}$/);
  });

  it("falls back to a generated ID when no hook assigned one", () => {
    expect(correlationIdOf({ correlationId: null } as never)).toMatch(/^corr_/);
    expect(correlationIdOf({ correlationId: "corr_known" } as never)).toBe("corr_known");
  });

  it("stamps every response, including failures, and echoes valid inbound IDs", async () => {
    const { app } = buildTestApp();
    try {
      const generated = await app.inject({ method: "GET", url: "/health/live" });
      expect(IdSchema.safeParse(generated.headers[CORRELATION_ID_HEADER]).success).toBe(true);

      const echoed = await app.inject({
        method: "GET",
        url: "/health/live",
        headers: { [CORRELATION_ID_HEADER]: "corr_from_client" },
      });
      expect(echoed.headers[CORRELATION_ID_HEADER]).toBe("corr_from_client");
      expect(echoed.json().correlationId).toBe("corr_from_client");

      const replaced = await app.inject({
        method: "GET",
        url: "/health/live",
        headers: { [CORRELATION_ID_HEADER]: "garbage header value" },
      });
      expect(replaced.headers[CORRELATION_ID_HEADER]).not.toBe("garbage header value");

      const rejected = await app.inject({ method: "GET", url: "/v1/organizations/org_northstar" });
      expect(rejected.statusCode).toBe(401);
      expect(rejected.headers[CORRELATION_ID_HEADER]).toBe(rejected.json().correlationId);
    } finally {
      await app.close();
    }
  });
});
