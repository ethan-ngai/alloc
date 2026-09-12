/**
 * USD money in minor units. The contract money schemas are strict, so `currency` is re-asserted on
 * every constructed object. `UsdAmount` is deliberately wider than the contract's non-negative
 * money type: it also carries signed amounts (budget availability, corrections, scenario deltas),
 * and every emitted payload is validated by the contract schema before it leaves the process.
 */
export interface UsdAmount {
  amountMinor: number;
  currency: "USD";
}

export function usd(amountMinor: number): UsdAmount {
  return { amountMinor, currency: "USD" };
}
