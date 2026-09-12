/**
 * Collection specs for the action executor: the provider-side operation ledger
 * it delivers against, and the immutable receipts it records. The provider
 * ledger is a simulated external system of record, not Alloc financial state;
 * the receipt collection is Alloc's record of observed outcomes.
 */
import { CONTRACT_SCHEMA_VERSION } from "@alloc/contracts";
import type { Db } from "mongodb";
import {
  ID, NON_EMPTY_STRING, ORG_ID, POSITIVE_MONEY, RECORD_REF, TIMESTAMP, ensureCollections, schema,
  type CollectionSpec,
} from "../mongo/collections.js";

export const ACTION_RECEIPTS_COLLECTION = "financial_action_receipts";
export const PROVIDER_OPERATIONS_COLLECTION = "simulated_provider_operations";

const SPECS: readonly CollectionSpec[] = [
  {
    name: ACTION_RECEIPTS_COLLECTION,
    validator: schema(
      ["schemaVersion", "organizationId", "receiptId", "actionIntentRef", "providerInstanceId", "providerOperationId", "outcome", "amount", "observedAt"],
      {
        schemaVersion: { enum: [CONTRACT_SCHEMA_VERSION] }, organizationId: ORG_ID, receiptId: ID,
        actionIntentRef: RECORD_REF, providerInstanceId: ID, providerOperationId: NON_EMPTY_STRING,
        outcome: { enum: ["succeeded", "failed", "outcome_unknown"] }, amount: POSITIVE_MONEY,
        observedAt: TIMESTAMP, rawReceiptRef: RECORD_REF,
      },
    ),
    indexes: [
      { key: { organizationId: 1, receiptId: 1 }, name: "receipt_identity", unique: true },
      // One receipt per external operation: a duplicate delivery cannot be recorded twice.
      { key: { organizationId: 1, providerInstanceId: 1, providerOperationId: 1 }, name: "receipt_provider_operation", unique: true },
      { key: { organizationId: 1, "actionIntentRef.id": 1 }, name: "receipt_intent" },
    ],
  },
  {
    name: PROVIDER_OPERATIONS_COLLECTION,
    validator: schema(
      ["schemaVersion", "organizationId", "providerInstanceId", "providerOperationId", "idempotencyKey", "amount", "vendorId", "outcome", "observedAt"],
      {
        schemaVersion: { enum: [CONTRACT_SCHEMA_VERSION] }, organizationId: ORG_ID, providerInstanceId: ID,
        providerOperationId: NON_EMPTY_STRING, idempotencyKey: NON_EMPTY_STRING, amount: POSITIVE_MONEY,
        vendorId: ID, outcome: { enum: ["applied", "declined"] }, observedAt: TIMESTAMP,
      },
    ),
    indexes: [
      // The provider's idempotency contract: one operation per delivery key.
      { key: { organizationId: 1, providerInstanceId: 1, idempotencyKey: 1 }, name: "provider_idempotency", unique: true },
      { key: { organizationId: 1, providerInstanceId: 1, providerOperationId: 1 }, name: "provider_operation_identity", unique: true },
    ],
  },
];

/** Creates or revalidates every executor collection and index. Idempotent. */
export async function ensureExecutionCollections(db: Db): Promise<void> {
  await ensureCollections(db, SPECS);
}
