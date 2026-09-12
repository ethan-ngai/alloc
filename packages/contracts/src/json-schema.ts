import { z } from "zod";
import { CONTRACT_SCHEMA_VERSION } from "./common.js";
import { ContractSchemaRegistry } from "./registry.js";

export function generateJsonSchemas(): Record<string, object> {
  return Object.fromEntries(
    Object.entries(ContractSchemaRegistry).map(([name, schema]) => {
      const generated = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
      return [name, {
        ...generated,
        $id: `https://alloc.local/contracts/${CONTRACT_SCHEMA_VERSION}/${name}.schema.json`,
        title: name,
        "x-alloc-contract-version": CONTRACT_SCHEMA_VERSION,
      }];
    }),
  );
}
