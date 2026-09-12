import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateJsonSchemas } from "./json-schema.js";
import { contractExamples, northstarScenario } from "./fixtures.js";

const outputDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../schemas");
const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
await mkdir(outputDirectory, { recursive: true });
await mkdir(fixtureDirectory, { recursive: true });

for (const entry of await readdir(outputDirectory)) {
  if (entry.endsWith(".schema.json")) await rm(resolve(outputDirectory, entry));
}

for (const [name, schema] of Object.entries(generateJsonSchemas())) {
  await writeFile(resolve(outputDirectory, `${name}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`, "utf8");
}

await writeFile(resolve(fixtureDirectory, "northstar-scenario.json"), `${JSON.stringify(northstarScenario, null, 2)}\n`, "utf8");
await writeFile(resolve(fixtureDirectory, "representative-examples.json"), `${JSON.stringify(contractExamples, null, 2)}\n`, "utf8");
