/**
 * Local simulated spending provider.
 *
 * It stands in for an external procurement/card system: it owns a durable
 * operation ledger (`simulated_provider_operations`) that the executor never
 * writes directly, and it enforces one operation per
 * `(organizationId, providerInstanceId, idempotencyKey)`. A repeated delivery
 * of the same key returns the operation that was already recorded, so a crash
 * or duplicate dispatch cannot apply the side effect twice.
 *
 * Failure modes are controllable so the executor's ambiguous-outcome and
 * crash-recovery paths can be exercised deterministically:
 *
 * - `none`                     deliver, record, report the recorded outcome
 * - `decline`                  record a declined operation; no side effect
 * - `timeout_after_apply`      record the operation, then report no response
 * - `timeout_without_apply`    record nothing, then report no response
 * - `unavailable_before_send`  record nothing, report a transport failure
 *
 * `timeout_without_apply` and `unavailable_before_send` both leave no provider
 * operation; `unavailable_before_send` additionally proves the request never
 * reached the provider, which is what makes returning the intent to `pending`
 * safe.
 */
import { CONTRACT_SCHEMA_VERSION, type Money } from "@alloc/contracts";
import type { Collection, Db } from "mongodb";
import { recordId } from "../finance/ids.js";
import { PROVIDER_OPERATIONS_COLLECTION } from "./collections.js";

export const SIMULATED_FAILURE_MODES = [
  "none",
  "decline",
  "timeout_after_apply",
  "timeout_without_apply",
  "unavailable_before_send",
] as const;
export type SimulatedFailureMode = (typeof SIMULATED_FAILURE_MODES)[number];

export interface SpendDelivery {
  readonly organizationId: string;
  readonly providerInstanceId: string;
  readonly idempotencyKey: string;
  readonly amount: Money;
  readonly vendorId: string;
  /** Carried into provider logs; never a command or authorization input. */
  readonly correlationId: string;
}

/** The provider's own record of one delivery attempt. */
export interface ProviderOperation {
  readonly providerOperationId: string;
  readonly organizationId: string;
  readonly providerInstanceId: string;
  readonly idempotencyKey: string;
  readonly amount: Money;
  readonly vendorId: string;
  readonly outcome: "applied" | "declined";
  readonly observedAt: string;
}

export type ProviderDeliveryResult =
  | { readonly kind: "applied"; readonly operation: ProviderOperation }
  | { readonly kind: "declined"; readonly operation: ProviderOperation }
  /** The request may or may not have taken effect; only reconciliation can decide. */
  | { readonly kind: "outcome_unknown"; readonly reason: string }
  /** Proven not delivered: the transport failed before the provider saw it. */
  | { readonly kind: "unavailable"; readonly reason: string };

export type ProviderLookupResult =
  | { readonly kind: "found"; readonly operation: ProviderOperation }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface SpendProvider {
  /** Delivers once per idempotency key; replays return the recorded operation. */
  deliver(delivery: SpendDelivery): Promise<ProviderDeliveryResult>;
  /** Provider-side status lookup used by reconciliation. Never applies anything. */
  lookup(delivery: Pick<SpendDelivery, "organizationId" | "providerInstanceId" | "idempotencyKey">): Promise<ProviderLookupResult>;
}

export interface SimulatedSpendProviderOptions {
  /** Controllable failure injection; mutable so a test can move the provider between modes. */
  failureMode?: SimulatedFailureMode;
  now?: () => Date;
}

export class SimulatedSpendProvider implements SpendProvider {
  failureMode: SimulatedFailureMode;
  readonly #db: Db;
  readonly #now: () => Date;

  constructor(db: Db, options: SimulatedSpendProviderOptions = {}) {
    this.#db = db;
    this.failureMode = options.failureMode ?? "none";
    this.#now = options.now ?? (() => new Date());
  }

  async deliver(delivery: SpendDelivery): Promise<ProviderDeliveryResult> {
    if (this.failureMode === "unavailable_before_send") {
      return { kind: "unavailable", reason: "simulated transport failure before delivery" };
    }
    if (this.failureMode === "timeout_without_apply") {
      return { kind: "outcome_unknown", reason: "simulated timeout with no provider operation recorded" };
    }
    // A delivery of a key that already has an operation reports the recorded
    // outcome: the failure mode only shapes the first delivery of a key.
    const existing = await this.find(delivery);
    if (existing !== null) {
      return existing.outcome === "applied"
        ? { kind: "applied", operation: existing }
        : { kind: "declined", operation: existing };
    }
    if (this.failureMode === "timeout_after_apply") {
      await this.apply(delivery, "applied");
      return { kind: "outcome_unknown", reason: "simulated timeout after the provider applied the operation" };
    }
    const recorded = await this.apply(delivery, this.failureMode === "decline" ? "declined" : "applied");
    return recorded.outcome === "applied"
      ? { kind: "applied", operation: recorded }
      : { kind: "declined", operation: recorded };
  }

  async lookup(delivery: Pick<SpendDelivery, "organizationId" | "providerInstanceId" | "idempotencyKey">): Promise<ProviderLookupResult> {
    const operation = await this.find(delivery);
    return operation === null ? { kind: "absent" } : { kind: "found", operation };
  }

  #collection(): Collection<ProviderOperationDocument> {
    return this.#db.collection<ProviderOperationDocument>(PROVIDER_OPERATIONS_COLLECTION);
  }

  private async find(delivery: Pick<SpendDelivery, "organizationId" | "providerInstanceId" | "idempotencyKey">): Promise<ProviderOperation | null> {
    const document = await this.#collection().findOne(
      {
        organizationId: delivery.organizationId,
        providerInstanceId: delivery.providerInstanceId,
        idempotencyKey: delivery.idempotencyKey,
      },
      { projection: { _id: 0 } },
    );
    if (document === null) {
      return null;
    }
    const { schemaVersion: _schemaVersion, ...operation } = document;
    return operation;
  }

  /**
   * Atomically create-or-return: the unique idempotency index decides the
   * winner, so concurrent deliveries of one key converge on a single operation
   * and its recorded outcome.
   */
  private async apply(delivery: SpendDelivery, outcome: "applied" | "declined"): Promise<ProviderOperation> {
    const operation: ProviderOperation = {
      providerOperationId: recordId("provider_operation", delivery.organizationId, delivery.providerInstanceId, delivery.idempotencyKey),
      organizationId: delivery.organizationId,
      providerInstanceId: delivery.providerInstanceId,
      idempotencyKey: delivery.idempotencyKey,
      amount: delivery.amount,
      vendorId: delivery.vendorId,
      outcome,
      observedAt: this.#now().toISOString(),
    };
    const collection = this.#collection();
    const stored = await collection.findOneAndUpdate(
      {
        organizationId: operation.organizationId,
        providerInstanceId: operation.providerInstanceId,
        idempotencyKey: operation.idempotencyKey,
      },
      { $setOnInsert: { schemaVersion: CONTRACT_SCHEMA_VERSION, ...operation } },
      { upsert: true, returnDocument: "after", projection: { _id: 0 } },
    );
    if (stored !== null) {
      // The stored record is authoritative, including a concurrent winner.
      const { schemaVersion: _schemaVersion, ...recorded } = stored;
      return recorded;
    }
    // A concurrent delivery can lose the upsert race; the winner's operation is authoritative.
    const existing = await this.find(operation);
    if (existing === null) {
      throw new Error(`provider operation ${operation.providerOperationId} vanished after a conflicting insert`);
    }
    return existing;
  }
}

interface ProviderOperationDocument extends ProviderOperation {
  schemaVersion: string;
}
