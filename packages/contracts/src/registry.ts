import type { z } from "zod";
import * as api from "./api.js";
import * as common from "./common.js";
import * as events from "./events.js";
import * as financial from "./financial.js";
import * as memory from "./memory.js";
import * as runtime from "./runtime.js";
import * as tools from "./tools.js";

type Schema = z.ZodType;

function pickSchemas(module: Record<string, unknown>): Record<string, Schema> {
  return Object.fromEntries(
    Object.entries(module).filter(([name, value]) => name.endsWith("Schema") && typeof value === "object" && value !== null),
  ) as Record<string, Schema>;
}

export const ContractSchemaRegistry: Readonly<Record<string, Schema>> = Object.freeze({
  ...pickSchemas(common),
  ...pickSchemas(financial),
  ...pickSchemas(memory),
  ...pickSchemas(runtime),
  ...pickSchemas(api),
  ...pickSchemas(events),
  ...pickSchemas(tools),
});
