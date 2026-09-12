export interface ReadinessSnapshot {
  readonly ready: boolean;
  /** Internal reason for `ready: false`. Never returned to clients. */
  readonly reason?: string;
}

/**
 * Readiness is owned by the process, not recomputed per probe: it turns ready
 * only after the MongoDB connection, replica-set capability check, validators,
 * and indexes are in place, and turns unready when the dependency fails or the
 * process starts shutting down.
 */
export interface Readiness {
  snapshot(): ReadinessSnapshot;
  markReady(): void;
  markNotReady(reason: string): void;
}

export function createReadiness(): Readiness {
  let snapshot: ReadinessSnapshot = { ready: false, reason: "startup in progress" };

  return {
    snapshot: () => snapshot,
    markReady: () => {
      snapshot = { ready: true };
    },
    markNotReady: (reason: string) => {
      snapshot = { ready: false, reason };
    },
  };
}
