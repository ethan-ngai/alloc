import type { ScopeRef } from "./contract-types.js";

export interface IdFactory {
  next(prefix: string): string;
}

/**
 * `prefix_mock_0001`. One counter per store, so generated IDs are a deterministic function of call
 * order. Every result satisfies the contract `IdSchema` (`^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$`).
 */
export function createIdFactory(): IdFactory {
  let counter = 0;
  return {
    next: (prefix) => `${prefix}_mock_${String(++counter).padStart(4, "0")}`,
  };
}

/**
 * The frozen forecast-ID rule reused by the seeded packs and `forecasts.run`:
 * `forecast_` plus the scope ID with its type prefix stripped
 * (`department_field_engineering` → `forecast_field_engineering`).
 */
export function forecastIdForScope(scope: ScopeRef): string {
  return `forecast_${scope.id.replace(new RegExp(`^${scope.type}_`), "")}`;
}
