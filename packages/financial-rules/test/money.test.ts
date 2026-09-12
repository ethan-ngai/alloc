import { describe, expect, it } from "vitest";
import {
  assertNonNegativeUsd, assertPositiveUsd, assertSafeMinor, assertUsdAmount,
  addUsd, compareUsd, equalsUsd, isZeroUsd, maxUsd, subtractUsd, sumUsd, usd,
} from "../src/index.js";
import { errorCode, errorMessage } from "./harness.js";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

describe("checked USD arithmetic", () => {
  it("rejects non-integer, non-numeric, and unsafe minor units", () => {
    expect(usd(0)).toEqual({ amountMinor: 0, currency: "USD" });
    expect(errorCode(() => usd(1.5))).toBe("MALFORMED_AMOUNT");
    expect(errorCode(() => usd(Number.NaN))).toBe("MALFORMED_AMOUNT");
    expect(errorCode(() => usd(MAX_SAFE + 1))).toBe("UNSAFE_INTEGER");
    expect(errorCode(() => assertSafeMinor("100", "amountMinor"))).toBe("MALFORMED_AMOUNT");
    expect(assertSafeMinor(-100, "amountMinor")).toBe(-100);
    expect(errorMessage(() => usd(1.5))).toMatch(/^MALFORMED_AMOUNT at amountMinor:/);
  });

  it("rejects currency mismatches and malformed money objects", () => {
    expect(assertUsdAmount({ amountMinor: 100, currency: "USD" }, "amount")).toEqual({ amountMinor: 100, currency: "USD" });
    expect(errorCode(() => assertUsdAmount({ amountMinor: 100, currency: "EUR" }, "amount"))).toBe("CURRENCY_MISMATCH");
    expect(errorCode(() => assertUsdAmount({ amountMinor: 100 }, "amount"))).toBe("CURRENCY_MISMATCH");
    expect(errorCode(() => assertUsdAmount({ currency: "USD" }, "amount"))).toBe("MALFORMED_AMOUNT");
    expect(errorCode(() => assertUsdAmount(null, "amount"))).toBe("MALFORMED_AMOUNT");
    expect(errorMessage(() => assertUsdAmount({ amountMinor: 100, currency: "EUR" }, "amount"))).toMatch(/amount\.currency/);
  });

  it("sign-checks amounts without touching safe integers", () => {
    expect(assertNonNegativeUsd(usd(0), "amount")).toEqual({ amountMinor: 0, currency: "USD" });
    expect(errorCode(() => assertNonNegativeUsd(usd(-1), "amount"))).toBe("NEGATIVE_AMOUNT");
    expect(assertPositiveUsd(usd(1), "amount")).toEqual({ amountMinor: 1, currency: "USD" });
    expect(errorCode(() => assertPositiveUsd(usd(0), "amount"))).toBe("NON_POSITIVE_AMOUNT");
  });

  it("adds, subtracts, and sums with overflow detection", () => {
    expect(addUsd(usd(18_000), usd(3_000))).toEqual({ amountMinor: 21_000, currency: "USD" });
    expect(errorCode(() => addUsd(usd(MAX_SAFE), usd(1)))).toBe("UNSAFE_INTEGER");
    expect(subtractUsd(usd(21_000), usd(24_000))).toEqual({ amountMinor: -3_000, currency: "USD" });
    expect(errorCode(() => subtractUsd(usd(-MAX_SAFE), usd(MAX_SAFE)))).toBe("UNSAFE_INTEGER");
    expect(sumUsd([])).toEqual({ amountMinor: 0, currency: "USD" });
    expect(sumUsd([usd(6_000), usd(3_000), usd(1)])).toEqual({ amountMinor: 9_001, currency: "USD" });
    expect(errorCode(() => sumUsd([usd(MAX_SAFE), usd(MAX_SAFE)]))).toBe("UNSAFE_INTEGER");
    expect(errorCode(() => sumUsd([usd(MAX_SAFE), usd(2), usd(-2)]))).toBe("UNSAFE_INTEGER");
  });

  it("compares amounts deterministically", () => {
    expect(compareUsd(usd(100), usd(200))).toBe(-1);
    expect(compareUsd(usd(200), usd(200))).toBe(0);
    expect(compareUsd(usd(300), usd(200))).toBe(1);
    expect(equalsUsd(usd(200), usd(200))).toBe(true);
    expect(equalsUsd(usd(200), usd(201))).toBe(false);
    expect(isZeroUsd(usd(0))).toBe(true);
    expect(maxUsd(usd(100), usd(200))).toEqual({ amountMinor: 200, currency: "USD" });
  });
});
