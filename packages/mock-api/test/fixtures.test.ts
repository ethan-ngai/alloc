import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractErrorSchema, OperationSchemas } from "@alloc/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_MOCK_CLOCK } from "../src/clock.js";
import { exportFixtures } from "../src/export-fixtures.js";
import { OPERATION_NAMES, isOperationName } from "../src/operations.js";

const FIXTURES_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");

const ManifestSchema = z.object({
  generatedBy: z.string().min(1),
  clock: z.string().min(1),
  provisional: z.boolean(),
  scenarioIds: z.record(z.string(), z.string()),
  fixtures: z.array(z.object({
    file: z.string().min(1),
    variant: z.string().min(1),
    operation: z.string().min(1).optional(),
    ok: z.boolean().optional(),
    schema: z.string().min(1).optional(),
    errorCode: z.string().min(1).optional(),
  })),
});

async function loadManifest() {
  return ManifestSchema.parse(JSON.parse(await readFile(join(FIXTURES_DIRECTORY, "manifest.json"), "utf8")) as unknown);
}

async function readFixture(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(FIXTURES_DIRECTORY, path), "utf8")) as unknown;
}

async function committedFixturePaths(): Promise<string[]> {
  const entries = await readdir(FIXTURES_DIRECTORY, { recursive: true });
  return entries.filter((entry) => entry.endsWith(".json")).sort();
}

describe("committed response fixtures", () => {
  it("validates every success fixture against the 1A result schema it claims", async () => {
    const manifest = await loadManifest();
    const covered = new Set<string>();
    for (const entry of manifest.fixtures.filter((fixture) => fixture.ok === true)) {
      const operation = entry.operation;
      if (operation === undefined || !isOperationName(operation)) {
        throw new Error(`${entry.file} does not name a catalogued operation`);
      }
      const parsed = OperationSchemas[operation].result.parse(await readFixture(entry.file));
      expect(parsed.schemaVersion).toBe("1.0.0");
      expect(parsed.ok).toBe(true);
      covered.add(operation);
    }
    expect([...covered].sort()).toEqual([...OPERATION_NAMES].sort());
  });

  it("carries the declared contract error code on every failure fixture", async () => {
    const manifest = await loadManifest();
    const failures = manifest.fixtures.filter((fixture) => fixture.ok !== true);
    expect(failures.length).toBeGreaterThanOrEqual(6);
    for (const entry of failures) {
      const body = await readFixture(entry.file);
      const envelope = z.object({ ok: z.literal(false), error: ContractErrorSchema }).parse(body);
      expect(entry.schema).toBe("ContractError");
      expect(envelope.error.code).toBe(entry.errorCode);
      expect(envelope.error.schemaVersion).toBe("1.0.0");
    }
  });

  it("keeps provisional status out of every contract payload", async () => {
    const manifest = await loadManifest();
    expect(manifest.provisional).toBe(true);
    expect(manifest.clock).toBe(DEFAULT_MOCK_CLOCK);
    for (const path of await committedFixturePaths()) {
      if (path === "manifest.json") continue;
      expect(await readFile(join(FIXTURES_DIRECTORY, path), "utf8")).not.toContain("provisional");
    }
  });

  it("is reproducible from the running mock without touching disk", async () => {
    const regenerated = await exportFixtures({ write: false });
    const committed = await committedFixturePaths();
    expect(Object.keys(regenerated).sort()).toEqual(committed);
    for (const path of committed) {
      expect(regenerated[path], `${path} drifted from the mock`).toBe(await readFile(join(FIXTURES_DIRECTORY, path), "utf8"));
    }
  });
});
