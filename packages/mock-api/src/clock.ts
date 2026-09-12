/**
 * Logical clock. The mock never reads the wall clock: every timestamp it emits is derived from the
 * clock start passed to `createMockStore` plus one logical minute per `tick`, so two servers driven
 * through the same call sequence emit byte-identical bodies.
 */
export interface Clock {
  now(): string;
  tick(steps?: number): string;
}

const MINUTE_MS = 60_000;

/** Byte-identical to the timestamp format the 1A fixtures use: `2026-09-12T14:00:00Z`. */
export function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function createClock(startIso: string): Clock {
  let current = Date.parse(startIso);
  if (Number.isNaN(current)) throw new Error(`createClock: invalid start instant ${startIso}`);
  return {
    now: () => stamp(current),
    tick: (steps = 1) => {
      current += steps * MINUTE_MS;
      return stamp(current);
    },
  };
}

export const DEFAULT_MOCK_CLOCK = "2026-09-12T14:00:00Z";
