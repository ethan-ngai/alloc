/**
 * Action executor: delivers persisted action intents to the spending provider
 * and records the observed outcome as an immutable receipt.
 *
 * Ordering and duplicate rules, all enforced against the stored revision:
 *
 * 1. `pending → dispatching` is a single-document compare-and-swap, so exactly
 *    one caller claims an intent; a loser reports the current state instead.
 * 2. A receipt already recorded for the intent wins: the provider is not called
 *    again and the intent converges on the receipt's outcome.
 * 3. The provider is idempotent per `idempotencyKey`, so recovery may re-deliver
 *    an intent left in `dispatching` by a crash. Re-delivery cannot apply the
 *    side effect twice, and it converges on the single recorded operation.
 * 4. A definite outcome (`applied`, `declined`) settles the intent and its
 *    receipt in one transaction; a transition that loses the race changes
 *    nothing and is reported as skipped.
 * 5. An ambiguous outcome is never retried blind: the intent stays
 *    `outcome_unknown` — exposure is retained — until `reconcileIntent` proves
 *    from the provider's ledger whether the operation exists.
 * 6. A transport failure before delivery leaves no provider operation, so the
 *    intent returns to `pending` for a later attempt.
 *
 * The executor never mutates budgets, commitments, or postings: a failed or
 * ambiguous delivery retains the reservation instead of releasing it.
 */
import {
  ActionIntentSchema, ActionReceiptSchema, CONTRACT_SCHEMA_VERSION,
  type ActionIntent, type ActionReceipt,
} from "@alloc/contracts";
import type { ClientSession, Db } from "mongodb";
import { appendAuditEvents } from "../finance/audit.js";
import { ACTION_INTENTS_COLLECTION } from "../finance/collections.js";
import { recordId } from "../finance/ids.js";
import { ACTION_RECEIPTS_COLLECTION } from "./collections.js";
import type { ProviderOperation, SpendProvider } from "./provider.js";

export const EXECUTOR_SERVICE_IDENTITY = "service_action_executor";

/** States the executor acts on; every other state is terminal or human-owned. */
const ACTIVE_STATES = ["pending", "dispatching", "outcome_unknown"] as const;

export interface ExecutorHooks {
  /**
   * Test seam for the crash-after-side-effect path: runs after the provider call
   * resolves and before any outcome is persisted.
   */
  readonly afterDelivery?: (intent: ActionIntent) => Promise<void>;
}

export type IntentOutcome =
  | { readonly status: "succeeded" | "failed"; readonly intent: ActionIntent; readonly receipt: ActionReceipt }
  | { readonly status: "outcome_unknown"; readonly intent: ActionIntent; readonly reason: string }
  /** No delivery took effect; the intent is eligible for another attempt. */
  | { readonly status: "pending"; readonly intent: ActionIntent }
  | { readonly status: "skipped"; readonly intent: ActionIntent; readonly reason: string }
  /** The attempt failed outright; the intent keeps its stored state. */
  | { readonly status: "error"; readonly intent: ActionIntent; readonly reason: string }
  | { readonly status: "missing" };

export interface ExecutionSweep {
  readonly results: readonly IntentOutcome[];
  readonly idle: boolean;
}

export class MongoActionExecutor {
  constructor(
    private readonly db: Db,
    private readonly withTransaction: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>,
    private readonly provider: SpendProvider,
    private readonly now: () => Date = () => new Date(),
    private readonly hooks: ExecutorHooks = {},
  ) {}

  /** Delivers one intent, or reports why it was not delivered. */
  async dispatchIntent(organizationId: string, actionIntentId: string): Promise<IntentOutcome> {
    const intent = await this.loadIntent(organizationId, actionIntentId);
    if (intent === null) {
      return { status: "missing" };
    }
    if (intent.state !== "pending" && intent.state !== "dispatching") {
      return { status: "skipped", intent, reason: `intent is ${intent.state}` };
    }
    // `dispatching` is recovered without re-claiming: the idempotency key makes a
    // repeated delivery safe, so a worker that died mid-dispatch cannot strand
    // the intent.
    const claimed = intent.state === "pending" ? await this.claim(intent) : intent;
    if (claimed === null) {
      const current = await this.loadIntent(organizationId, actionIntentId);
      return current === null
        ? { status: "missing" }
        : { status: "skipped", intent: current, reason: "another worker claimed the intent" };
    }

    const recorded = await this.receiptForIntent(organizationId, actionIntentId);
    if (recorded !== null) {
      const converged = await this.converge(claimed, recorded);
      return converged === null
        ? { status: "skipped", intent: claimed, reason: "intent changed while adopting its receipt" }
        : { status: recorded.outcome === "succeeded" ? "succeeded" : "failed", intent: converged, receipt: recorded };
    }

    const delivery = await this.provider.deliver({
      organizationId: claimed.organizationId,
      providerInstanceId: claimed.providerInstanceId,
      idempotencyKey: claimed.idempotencyKey,
      amount: claimed.action.amount,
      vendorId: claimed.action.vendorId,
      correlationId: recordId("correlation", claimed.actionIntentId, claimed.revision),
    });
    await this.hooks.afterDelivery?.(claimed);

    switch (delivery.kind) {
      case "applied":
      case "declined": {
        const outcome = delivery.kind === "applied" ? "succeeded" : "failed";
        return this.recordOutcome(claimed, outcome, delivery.operation, "action.settled");
      }
      case "outcome_unknown": {
        const flagged = await this.transitionWithAudit(claimed, "outcome_unknown", {
          type: "action.outcome_unknown",
          details: { providerInstanceId: claimed.providerInstanceId, reason: delivery.reason },
        });
        return flagged === null
          ? { status: "skipped", intent: claimed, reason: "intent changed while recording the unknown outcome" }
          : { status: "outcome_unknown", intent: flagged, reason: delivery.reason };
      }
      case "unavailable": {
        const released = await this.transitionWithAudit(claimed, "pending", {
          type: "action.delivery_failed",
          details: { providerInstanceId: claimed.providerInstanceId, reason: delivery.reason },
        });
        return released === null
          ? { status: "skipped", intent: claimed, reason: "intent changed while releasing the delivery" }
          : { status: "pending", intent: released };
      }
    }
  }

  /**
   * Resolves an `outcome_unknown` intent from the provider's own ledger. Funds
   * are never released here: the reservation stays until the provider proves
   * whether the operation exists.
   */
  async reconcileIntent(organizationId: string, actionIntentId: string): Promise<IntentOutcome> {
    const intent = await this.loadIntent(organizationId, actionIntentId);
    if (intent === null) {
      return { status: "missing" };
    }
    if (intent.state !== "outcome_unknown") {
      return { status: "skipped", intent, reason: `intent is ${intent.state}` };
    }
    const recorded = await this.receiptForIntent(organizationId, actionIntentId);
    if (recorded !== null) {
      const converged = await this.converge(intent, recorded);
      return converged === null
        ? { status: "skipped", intent, reason: "intent changed while adopting its receipt" }
        : { status: recorded.outcome === "succeeded" ? "succeeded" : "failed", intent: converged, receipt: recorded };
    }

    const lookup = await this.provider.lookup({
      organizationId: intent.organizationId,
      providerInstanceId: intent.providerInstanceId,
      idempotencyKey: intent.idempotencyKey,
    });
    switch (lookup.kind) {
      case "unavailable":
        return { status: "outcome_unknown", intent, reason: lookup.reason };
      case "absent": {
        // The provider recorded nothing, so the delivery never took effect and a
        // later attempt cannot double-apply it.
        const released = await this.transitionWithAudit(intent, "pending", {
          type: "action.reconciled",
          details: { providerInstanceId: intent.providerInstanceId, disposition: "not_delivered" },
        });
        return released === null
          ? { status: "skipped", intent, reason: "intent changed while reconciling" }
          : { status: "pending", intent: released };
      }
      case "found":
        return this.recordOutcome(
          intent,
          lookup.operation.outcome === "applied" ? "succeeded" : "failed",
          lookup.operation,
          "action.reconciled",
        );
    }
  }

  /** One pass over actionable intents: dispatch, recover, and reconcile. */
  async runOnce(options: { organizationId?: string; limit?: number } = {}): Promise<ExecutionSweep> {
    const documents = await this.db.collection(ACTION_INTENTS_COLLECTION)
      .find({
        state: { $in: [...ACTIVE_STATES] },
        ...(options.organizationId === undefined ? {} : { organizationId: options.organizationId }),
      }, { projection: { _id: 0 } })
      .sort({ createdAt: 1, actionIntentId: 1 })
      .limit(options.limit ?? 10)
      .toArray();
    const results: IntentOutcome[] = [];
    for (const document of documents) {
      const intent = ActionIntentSchema.parse(document);
      // One failing attempt must not stop the pass: the intent keeps its state
      // and the remaining work still runs.
      try {
        results.push(intent.state === "outcome_unknown"
          ? await this.reconcileIntent(intent.organizationId, intent.actionIntentId)
          : await this.dispatchIntent(intent.organizationId, intent.actionIntentId));
      } catch (error) {
        results.push({ status: "error", intent, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const idle = results.every((result) => result.status === "skipped" || result.status === "missing");
    return { results, idle };
  }

  async receiptForIntent(organizationId: string, actionIntentId: string): Promise<ActionReceipt | null> {
    const document = await this.db.collection(ACTION_RECEIPTS_COLLECTION).findOne(
      { organizationId, "actionIntentRef.id": actionIntentId },
      { projection: { _id: 0 }, sort: { observedAt: -1 } },
    );
    return document === null ? null : ActionReceiptSchema.parse(document);
  }

  private async loadIntent(organizationId: string, actionIntentId: string): Promise<ActionIntent | null> {
    const document = await this.db.collection(ACTION_INTENTS_COLLECTION).findOne(
      { organizationId, actionIntentId },
      { projection: { _id: 0 } },
    );
    return document === null ? null : ActionIntentSchema.parse(document);
  }

  /** Single-document compare-and-swap: one claimer wins, the rest observe. */
  private async claim(intent: ActionIntent): Promise<ActionIntent | null> {
    const next = ActionIntentSchema.parse({ ...intent, state: "dispatching", revision: intent.revision + 1 });
    const result = await this.db.collection(ACTION_INTENTS_COLLECTION).updateOne(
      { organizationId: intent.organizationId, actionIntentId: intent.actionIntentId, state: "pending", revision: intent.revision },
      { $set: { state: next.state, revision: next.revision } },
    );
    return result.matchedCount === 1 ? next : null;
  }

  private async transition(intent: ActionIntent, state: ActionIntent["state"], session: ClientSession): Promise<ActionIntent | null> {
    const next = ActionIntentSchema.parse({ ...intent, state, revision: intent.revision + 1 });
    const result = await this.db.collection(ACTION_INTENTS_COLLECTION).updateOne(
      { organizationId: intent.organizationId, actionIntentId: intent.actionIntentId, state: intent.state, revision: intent.revision },
      { $set: { state: next.state, revision: next.revision } },
      { session },
    );
    return result.matchedCount === 1 ? next : null;
  }

  /** State change and audit entry commit together, or neither does. */
  private async transitionWithAudit(
    intent: ActionIntent,
    state: ActionIntent["state"],
    event: { type: string; details: Record<string, unknown> },
  ): Promise<ActionIntent | null> {
    const occurredAt = this.now().toISOString();
    return this.withTransaction(async (session) => {
      const next = await this.transition(intent, state, session);
      if (next === null) {
        return null;
      }
      await appendAuditEvents(this.db, intent.organizationId, `${intent.actionIntentId}:${next.revision}`, [{
        type: event.type,
        subjectRef: { type: "action_intent", id: intent.actionIntentId, revision: next.revision },
        requestId: intent.requestRef.id,
        actorId: EXECUTOR_SERVICE_IDENTITY,
        actorRoles: ["executor"],
        commandId: intent.commandId,
        correlationId: recordId("correlation", intent.actionIntentId, next.revision),
        occurredAt,
        details: event.details,
      }], session);
      return next;
    });
  }

  /** Settles the intent and persists its receipt in one transaction. */
  private async recordOutcome(
    intent: ActionIntent,
    outcome: "succeeded" | "failed",
    operation: ProviderOperation,
    auditType: string,
  ): Promise<IntentOutcome> {
    const receipt = ActionReceiptSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      organizationId: intent.organizationId,
      receiptId: recordId("receipt", intent.organizationId, operation.providerInstanceId, operation.providerOperationId),
      actionIntentRef: { type: "action_intent", id: intent.actionIntentId, revision: intent.revision },
      providerInstanceId: operation.providerInstanceId,
      providerOperationId: operation.providerOperationId,
      outcome,
      amount: operation.amount,
      observedAt: this.now().toISOString(),
      rawReceiptRef: { type: "provider_operation", id: operation.providerOperationId, revision: 1 },
    });
    const nextState = outcome === "succeeded" ? "succeeded" : "failed";
    const occurredAt = this.now().toISOString();
    const settled = await this.withTransaction(async (session) => {
      const next = await this.transition(intent, nextState, session);
      if (next === null) {
        return null;
      }
      // One receipt per provider operation; a replay adopts the stored record.
      await this.db.collection(ACTION_RECEIPTS_COLLECTION).updateOne(
        { organizationId: receipt.organizationId, receiptId: receipt.receiptId },
        { $setOnInsert: { ...receipt } },
        { upsert: true, session },
      );
      await appendAuditEvents(this.db, intent.organizationId, `${intent.actionIntentId}:${next.revision}`, [{
        type: auditType,
        subjectRef: { type: "action_intent", id: intent.actionIntentId, revision: next.revision },
        requestId: intent.requestRef.id,
        actorId: EXECUTOR_SERVICE_IDENTITY,
        actorRoles: ["executor"],
        commandId: intent.commandId,
        correlationId: recordId("correlation", intent.actionIntentId, next.revision),
        occurredAt,
        details: {
          outcome,
          providerInstanceId: operation.providerInstanceId,
          providerOperationId: operation.providerOperationId,
          receiptId: receipt.receiptId,
        },
      }], session);
      return next;
    });
    if (settled === null) {
      return { status: "skipped", intent, reason: "intent changed while recording its outcome" };
    }
    const stored = await this.receiptForIntent(intent.organizationId, intent.actionIntentId);
    return { status: outcome, intent: settled, receipt: stored ?? receipt };
  }

  /** Adopts an already-recorded receipt without calling the provider again. */
  private async converge(intent: ActionIntent, receipt: ActionReceipt): Promise<ActionIntent | null> {
    const state = receipt.outcome === "succeeded" ? "succeeded" : "failed";
    if (intent.state === state) {
      return intent;
    }
    return this.transitionWithAudit(intent, state, {
      type: "action.reconciled",
      details: {
        disposition: "receipt_already_recorded",
        providerInstanceId: receipt.providerInstanceId,
        providerOperationId: receipt.providerOperationId,
        receiptId: receipt.receiptId,
      },
    });
  }
}
