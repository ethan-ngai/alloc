import { startMongoReplicaSet } from "@alloc/test-support";
import { MongoError } from "mongodb";
import { describe, expect, it } from "vitest";
import { connectMongoRuntime, type MongoRuntime } from "../../src/mongo/runtime.js";
import { northstarOrganization } from "../support/organizations.js";

describe("dependency-aware readiness", () => {
  it("withdraws readiness when the database disappears and fails reads safely", async () => {
    const cluster = await startMongoReplicaSet({ label: "health" });
    let runtime: MongoRuntime | undefined;
    try {
      runtime = await connectMongoRuntime({
        uri: cluster.uri,
        database: cluster.database,
        heartbeatFrequencyMs: 500,
        serverSelectionTimeoutMs: 2_000,
      });
      expect(runtime.readiness.snapshot()).toEqual({ ready: true });

      await cluster.kill();

      expect(await waitFor(() => !runtime?.readiness.snapshot().ready, 30_000)).toBe(true);
      expect(runtime.readiness.snapshot().reason).toBe("database heartbeat failed");

      // A read against a vanished dependency is a dependency failure, not a
      // silent empty result or a tenant leak.
      await expect(runtime.organizations.findById(northstarOrganization.organizationId)).rejects.toBeInstanceOf(
        MongoError,
      );
      expect(runtime.readiness.snapshot()).toEqual({ ready: false, reason: "database heartbeat failed" });
    } finally {
      await runtime?.close().catch(() => undefined);
      await cluster.stop();
    }
  }, 120_000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return predicate();
}
