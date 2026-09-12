import { OperationSchemas } from "@alloc/contracts";
import type { OperationName } from "@alloc/contracts";

export const OPERATION_NAMES = Object.keys(OperationSchemas) as readonly OperationName[];

export function isOperationName(value: string): value is OperationName {
  return (OPERATION_NAMES as readonly string[]).includes(value);
}
