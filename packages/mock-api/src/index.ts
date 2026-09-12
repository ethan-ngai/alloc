/**
 * Browser-safe entry (`.`) for the frontend: the typed client, the shared error/status table, and
 * the operation name list. Nothing in this graph imports a `node:*` module, so Vite can bundle it.
 */
export { MOCK_FAULT_HEADER, MOCK_PRINCIPAL_HEADER, ContractClientError, createContractClient, operationPath } from "./client.js";
export type { ContractClient, ContractClientErrorOptions, ContractClientOptions } from "./client.js";
export { ERROR_STATUS, RETRYABLE_CODES, errorStatus, isErrorCode, isRetryable } from "./errors.js";
export type { ErrorCode } from "./errors.js";
export { OPERATION_NAMES, isOperationName } from "./operations.js";

export type { OperationInput, OperationName, OperationResult } from "@alloc/contracts";
