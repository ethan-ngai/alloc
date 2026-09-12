import { TimestampSchema } from "@alloc/contracts";

// Simulation time only: callers supply every instant; processing time never enters fixtures.
export function createScenarioClock(start) {
  let current = Date.parse(TimestampSchema.parse(start));
  return {
    now: () => new Date(current).toISOString(),
    advanceTo(value) {
      const next = Date.parse(TimestampSchema.parse(value));
      if (next < current) throw new Error("scenario clock cannot move backwards");
      current = next;
      return this.now();
    },
  };
}
