import { readFileSync } from "node:fs";
import { COMPANY_KEYS, fixturePath } from "./generate.js";
export { COMPANY_KEYS } from "./generate.js";
export { createScenarioClock } from "./clock.js";
export { validateCompany } from "./validate.js";
export { replayCompany, replaySources } from "./replay.js";

// Every caller gets its own copy, so one test/replay cannot mutate another company's seed.
export function loadCompany(key) {
  if (!COMPANY_KEYS.includes(key)) throw new Error(`unknown company: ${key}`);
  return JSON.parse(readFileSync(fixturePath(key), "utf8"));
}
