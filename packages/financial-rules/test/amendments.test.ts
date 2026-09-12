import { RequestAmendmentSchema, PurchaseRequestRevisionSchema } from "@alloc/contracts";
import { northstarScenario } from "@alloc/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { deriveAmendment, deriveAmendmentIncrease, usd } from "../src/index.js";
import { errorCode, request } from "./harness.js";

const first = PurchaseRequestRevisionSchema.parse(northstarScenario.requestRevisions[0]);
const second = PurchaseRequestRevisionSchema.parse(northstarScenario.requestRevisions[1]);
const third = PurchaseRequestRevisionSchema.parse(northstarScenario.requestRevisions[2]);
const firstAmendment = RequestAmendmentSchema.parse(northstarScenario.amendments[0]);
const secondAmendment = RequestAmendmentSchema.parse(northstarScenario.amendments[1]);

const amendmentProvenance = (sourceObjectId: string, at: string) => ({
  kind: "synthetic" as const, trust: "authoritative" as const, sourceInstanceId: "source_northstar_simulator",
  sourceObjectId, sourceRevision: "1", occurredAt: at, observedAt: at,
});

describe("increase-only amendment derivation", () => {
  it("derives the frozen 1A amendment records exactly", () => {
    expect(deriveAmendment({
      previous: first, revisedFullAmount: usd(21_000), amendmentId: "amendment_buffalo_trip_1",
      reason: "Additional pilot-day lodging", submittedBy: "employee_maya_chen", submittedAt: "2026-09-12T14:05:00Z",
      provenance: amendmentProvenance("buffalo-trip-amendment-1", "2026-09-12T14:05:00Z"),
    })).toEqual(firstAmendment);

    expect(deriveAmendment({
      previous: second, revisedFullAmount: usd(24_000), amendmentId: "amendment_buffalo_trip_2",
      reason: "Revised ground transportation", submittedBy: "employee_maya_chen", submittedAt: "2026-09-12T14:10:00Z",
      provenance: amendmentProvenance("buffalo-trip-amendment-2", "2026-09-12T14:10:00Z"),
    })).toEqual(secondAmendment);
  });

  it("accumulates the cumulative increase monotonically across successive increases", () => {
    const derived = deriveAmendment({
      previous: third, revisedFullAmount: usd(27_000), amendmentId: "amendment_buffalo_trip_3",
      reason: "Extended pilot week", submittedBy: "employee_maya_chen", submittedAt: "2026-09-12T14:20:00Z",
      provenance: amendmentProvenance("buffalo-trip-amendment-3", "2026-09-12T14:20:00Z"),
    });
    expect(derived.fromRevision).toBe(3);
    expect(derived.toRevision).toBe(4);
    expect(derived.increase).toEqual({ amountMinor: 3_000, currency: "USD" });
    expect(derived.cumulativeIncrease).toEqual({ amountMinor: 9_000, currency: "USD" });
    expect(RequestAmendmentSchema.parse(derived)).toEqual(derived);
  });

  it("refuses reductions, no-op amendments, and non-USD amounts", () => {
    expect(errorCode(() => deriveAmendmentIncrease(usd(21_000), usd(21_000)))).toBe("AMENDMENT_NOT_AN_INCREASE");
    expect(errorCode(() => deriveAmendmentIncrease(usd(24_000), usd(21_000)))).toBe("AMENDMENT_NOT_AN_INCREASE");
    expect(errorCode(() => deriveAmendmentIncrease({ amountMinor: 21_000, currency: "EUR" }, usd(24_000)))).toBe("CURRENCY_MISMATCH");
    expect(deriveAmendmentIncrease(usd(18_000), usd(21_000))).toEqual({ amountMinor: 3_000, currency: "USD" });
  });

  it("refuses to reduce a revision in place, so consumed allowance cannot be reset", () => {
    expect(errorCode(() => deriveAmendment({
      previous: third, revisedFullAmount: usd(21_000), amendmentId: "amendment_buffalo_trip_3",
      reason: "Reduce the trip", submittedBy: "employee_maya_chen", submittedAt: "2026-09-12T14:20:00Z",
      provenance: amendmentProvenance("buffalo-trip-amendment-3", "2026-09-12T14:20:00Z"),
    }))).toBe("AMENDMENT_NOT_AN_INCREASE");
  });

  it("rejects malformed identity and time inputs", () => {
    const base = {
      previous: request(), revisedFullAmount: usd(24_000), amendmentId: "amendment_buffalo_trip_2",
      reason: "Revised ground transportation", submittedBy: "employee_maya_chen", submittedAt: "2026-09-12T14:20:00Z",
      provenance: amendmentProvenance("buffalo-trip-amendment-2", "2026-09-12T14:20:00Z"),
    };
    expect(errorCode(() => deriveAmendment({ ...base, submittedAt: "2026-09-12" }))).toBe("INVALID_TIMESTAMP");
    expect(errorCode(() => deriveAmendment({ ...base, reason: "" }))).toBe("MISSING_REQUIRED_INPUT");
    expect(errorCode(() => deriveAmendment({ ...base, amendmentId: "" }))).toBe("MISSING_REQUIRED_INPUT");
    expect(errorCode(() => deriveAmendment({ ...base, submittedBy: "" }))).toBe("MISSING_REQUIRED_INPUT");
  });
});
