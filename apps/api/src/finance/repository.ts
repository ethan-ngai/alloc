import {
  ActionIntentSchema, ApprovalGrantSchema, BudgetAccountSchema, CommandMetaSchema, CommitmentSchema,
  CONTRACT_SCHEMA_VERSION, DecisionSchema, EvidenceSchema, PolicySchema, PostingCorrectionSchema, PostingSchema,
  PurchaseRequestRevisionSchema,
  type ActionIntent, type ApprovalGrant, type BudgetAccount, type Commitment, type Decision, type Evidence,
  type OperationInput, type Policy, type Posting, type PurchaseRequestRevision, type ScopeRef,
} from "@alloc/contracts";
import {
  approvalActionTypeFor, deriveAmendment, evaluateRequestPolicy, refOfPolicy, refOfRequest, REASON_CODE, usd,
  type ApproverAuthority, type BindingBudgetInput, type CumulativeTotalInput, type GrantContext,
  type PolicyEvaluationInput, type PolicyEvaluationResult, type TrustedPurposeState,
} from "@alloc/financial-rules";
import type { ClientSession, Db } from "mongodb";
import { z } from "zod";
import { appendAuditEvents, type AuditEventInput } from "./audit.js";
import { applyExposure, budgetRefOf, requestBudgetScopes, resolveBindingBudgets } from "./budgets.js";
import {
  ACTION_INTENTS_COLLECTION, AUDIT_EVENTS_COLLECTION, BUDGETS_COLLECTION, COMMANDS_COLLECTION, COMMITMENTS_COLLECTION,
  DECISIONS_COLLECTION, EVIDENCE_COLLECTION, GRANTS_COLLECTION, POLICY_GUARDS_COLLECTION, POLICIES_COLLECTION,
  PRINCIPAL_AUTHORITIES_COLLECTION, PURPOSES_COLLECTION, REQUEST_CURRENT_COLLECTION, REQUEST_REVISIONS_COLLECTION,
} from "./collections.js";
import { financeErrors } from "./errors.js";
import { fingerprint, recordId } from "./ids.js";
import type {
  AuditEventDocument, CommandDocument, FinancialContext, PolicyGuardDocument, PrincipalAuthorityDocument,
  PurposeDocument, RequestCurrentDocument,
} from "./internal.js";
import { applyCanonicalCorrection, applyCanonicalPosting } from "./postings.js";

export const FINANCE_MANAGER_ROLE = "finance_manager";
/** A review grant is valid for thirty minutes, then the revision needs a fresh decision. */
export const APPROVAL_GRANT_TTL_MS = 30 * 60 * 1_000;

type CommandMeta = z.infer<typeof CommandMetaSchema>;
type PostingCorrection = z.infer<typeof PostingCorrectionSchema>;
type AuditDraft = Omit<AuditEventInput, "actorId" | "actorRoles" | "commandId" | "correlationId" | "requestId">;

const VersionExpectationSchema = z.object({
  ref: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  expectedRevision: z.number().int().positive(),
});

export interface RequestView {
  readonly request: PurchaseRequestRevision;
  readonly decisions: Decision[];
  readonly commitment: Commitment | null;
}

export interface FinancialSeed {
  policies?: readonly Policy[];
  budgets?: readonly BudgetAccount[];
  evidence?: readonly Evidence[];
  purposes?: readonly { purpose: string; active: boolean; ref?: { type: string; id: string; revision?: number } }[];
  authorities?: readonly { principalId: string; roles: readonly string[]; scopes: readonly { type: string; id: string }[]; revoked?: boolean }[];
}

export interface FinancialRepository {
  createRequest(context: FinancialContext, input: OperationInput<"requests.create">): Promise<PurchaseRequestRevision>;
  amendRequest(context: FinancialContext, input: OperationInput<"requests.amend">): Promise<{ request: PurchaseRequestRevision; decision: Decision }>;
  getRequest(organizationId: string, requestId: string): Promise<RequestView | null>;
  decideReview(context: FinancialContext, input: OperationInput<"reviews.decide">): Promise<{ decision: Decision; commitment: Commitment | null }>;
  recordPosting(context: FinancialContext, input: OperationInput<"postings.record">): Promise<Posting>;
  correctPosting(context: FinancialContext, input: OperationInput<"postings.correct">): Promise<PostingCorrection>;
  currentActionIntent(organizationId: string, requestId: string): Promise<ActionIntent | null>;
  /** Canonical posting mutation shared with source ingestion. */
  applyPosting(posting: Posting, session: ClientSession): Promise<Posting>;
  listDecisions(organizationId: string, requestId: string): Promise<Decision[]>;
  listApprovalGrants(organizationId: string, requestId: string): Promise<ApprovalGrant[]>;
  listActionIntents(organizationId: string, requestId: string): Promise<ActionIntent[]>;
  listRequestRevisions(organizationId: string, requestId: string): Promise<PurchaseRequestRevision[]>;
  getCommitment(organizationId: string, requestId: string): Promise<Commitment | null>;
  getBudgetAccount(organizationId: string, budgetAccountId: string): Promise<BudgetAccount | null>;
  listAuditEvents(organizationId: string, requestId: string): Promise<AuditEventDocument[]>;
  seed(organizationId: string, seed: FinancialSeed): Promise<void>;
}

interface ResolvedAuthority {
  roles: string[];
  scopes: ScopeRef[];
  revoked: boolean;
}

interface DecisionFields {
  outcome: Decision["outcome"];
  reasonCodes: string[];
  policyRef: Decision["policyRef"];
  authorizationEpoch: number;
  evaluatedFullAmount: Decision["evaluatedFullAmount"];
  evaluatedCumulativeIncrease: Decision["evaluatedCumulativeIncrease"];
  factualInputs: Decision["factualInputs"];
  evidenceRefs: Decision["evidenceRefs"];
  requiredApproverRole: string | null;
  approvalGrantRef?: Decision["approvalGrantRef"];
  permittedAction: Decision["permittedAction"];
}

export class MongoFinancialRepository implements FinancialRepository {
  constructor(
    private readonly db: Db,
    private readonly withTransaction: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async applyPosting(posting: Posting, session: ClientSession): Promise<Posting> {
    return applyCanonicalPosting(this.db, posting, session, this.nowIso());
  }

  async createRequest(context: FinancialContext, input: OperationInput<"requests.create">): Promise<PurchaseRequestRevision> {
    this.assertTenant(context, input.meta.organizationId);
    const requestId = recordId("request", context.organizationId, input.meta.commandId);
    return this.runCommand("requests.create", context.organizationId, input.meta, input.payload, async (session) => {
      await this.assertExpectedVersions(context.organizationId, input.meta.expectedVersions, session);
      const actor = await this.requireAuthority(context, session);
      if (input.payload.requesterId !== context.principalId && !actor.roles.includes(FINANCE_MANAGER_ROLE)) {
        throw financeErrors.authorityDenied("only the requester or a finance manager may create a request");
      }
      const requesterRoles = await this.requesterRolesFor(context, input.payload.requesterId, session);
      if (!input.payload.scopes.some((scope) => scope.type === "organization" && scope.id === context.organizationId)) {
        throw financeErrors.validationFailed("request scopes must include the authenticated organization");
      }

      const submittedAt = this.nowIso();
      const base: PurchaseRequestRevision = {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        organizationId: context.organizationId,
        requestId,
        revision: 1,
        previousRevision: null,
        requesterId: input.payload.requesterId,
        purpose: input.payload.purpose,
        fullAmount: usd(input.payload.fullAmount.amountMinor),
        increaseFromPrevious: usd(0),
        cumulativeIncrease: usd(0),
        categoryId: input.payload.categoryId,
        scopes: input.payload.scopes.map((scope) => ({ ...scope })),
        evaluationState: "submitted",
        submittedAt,
        provenance: this.provenance(`${requestId}-submission`, "1", submittedAt),
        ...(input.payload.vendorId === undefined ? {} : { vendorId: input.payload.vendorId }),
        ...(input.payload.projectId === undefined ? {} : { projectId: input.payload.projectId }),
      };

      const evaluation = await this.evaluate(context.organizationId, base, requesterRoles, undefined, session);
      const revision: PurchaseRequestRevision = { ...base, evaluationState: evaluation.result.outcome };
      const decidedAt = this.nowIso();
      const decision = this.decisionFrom(revision, this.decisionId(context.organizationId, requestId, 1, input.meta.commandId), evaluation.result, decidedAt);

      await this.insertRevision(revision, session);
      await this.db.collection(REQUEST_CURRENT_COLLECTION).insertOne({
        organizationId: context.organizationId, requestId, currentRevision: 1, evaluationState: revision.evaluationState,
        requesterId: revision.requesterId, purpose: revision.purpose, cumulativeIncrease: revision.cumulativeIncrease,
        ...(revision.projectId === undefined ? {} : { projectId: revision.projectId }), updatedAt: decidedAt,
      }, { session });
      await this.insertDecision(decision, session);

      if (evaluation.result.outcome === "approved") {
        const commitment = await this.commitReservation(context.organizationId, revision, decision, evaluation.budgets, session);
        if (commitment) {
          await this.syncActionIntent(context, revision, decision, input.meta.commandId, session);
        }
      }

      await this.audit(context, input.meta, requestId, [
        { type: "request.created", subjectRef: refOfRequest(revision), occurredAt: submittedAt, details: { evaluationState: revision.evaluationState } },
        { type: "decision.recorded", subjectRef: { type: "decision", id: decision.decisionId, revision: 1 }, occurredAt: decidedAt, details: { outcome: decision.outcome, reasonCodes: decision.reasonCodes } },
      ], session);
      return revision;
    });
  }

  async amendRequest(context: FinancialContext, input: OperationInput<"requests.amend">): Promise<{ request: PurchaseRequestRevision; decision: Decision }> {
    this.assertTenant(context, input.meta.organizationId);
    return this.runCommand("requests.amend", context.organizationId, input.meta, input.payload, async (session) => {
      const requestId = input.payload.requestId;
      const current = await this.loadCurrent(context.organizationId, requestId, session);
      if (!current) {
        throw financeErrors.notFound(`request ${requestId} does not exist in this organization`);
      }
      if (!input.meta.expectedVersions.some((expectation) => expectation.ref.type === "request" && expectation.ref.id === requestId)) {
        throw financeErrors.validationFailed("an amendment must expect the current request revision in expectedVersions");
      }
      await this.assertExpectedVersions(context.organizationId, input.meta.expectedVersions, session);
      const actor = await this.requireAuthority(context, session);
      if (current.requesterId !== context.principalId && !actor.roles.includes(FINANCE_MANAGER_ROLE)) {
        throw financeErrors.authorityDenied("only the requester or a finance manager may amend a request");
      }
      if (current.evaluationState === "denied") {
        throw financeErrors.policyDenied(`request ${requestId} was denied and cannot be amended`, { reasonCode: "REQUEST_DENIED" });
      }
      await this.assertIntentAmendable(context.organizationId, requestId, session);

      const previous = await this.loadRevision(context.organizationId, requestId, current.currentRevision, session);
      if (!previous) {
        throw financeErrors.staleVersion(`request ${requestId} revision ${current.currentRevision} is missing`);
      }
      if (input.payload.revisedFullAmount.amountMinor <= previous.fullAmount.amountMinor) {
        throw financeErrors.validationFailed("revisedFullAmount must increase the requested amount", {
          reasonCode: "revisedAmountNotAnIncrease",
          previousFullAmount: previous.fullAmount.amountMinor,
          revisedFullAmount: input.payload.revisedFullAmount.amountMinor,
        });
      }
      const submittedAt = this.nowIso();
      const amendment = deriveAmendment({
        previous,
        revisedFullAmount: input.payload.revisedFullAmount,
        amendmentId: recordId("amendment", context.organizationId, requestId, previous.revision + 1, input.meta.commandId),
        reason: input.payload.reason,
        submittedBy: context.principalId,
        submittedAt,
        provenance: this.provenance(`${requestId}-amendment-${previous.revision + 1}`, String(previous.revision + 1), submittedAt),
      });
      const revision: PurchaseRequestRevision = {
        ...previous,
        revision: amendment.toRevision,
        previousRevision: previous.revision,
        fullAmount: amendment.revisedFullAmount,
        increaseFromPrevious: amendment.increase,
        cumulativeIncrease: amendment.cumulativeIncrease,
        evaluationState: "submitted",
        submittedAt,
        provenance: amendment.provenance,
      };

      const requesterRoles = await this.requesterRolesFor(context, revision.requesterId, session);
      const evaluation = await this.evaluate(context.organizationId, revision, requesterRoles, undefined, session);
      const decided: PurchaseRequestRevision = { ...revision, evaluationState: evaluation.result.outcome };
      const decidedAt = this.nowIso();
      const decision = this.decisionFrom(decided, this.decisionId(context.organizationId, requestId, decided.revision, input.meta.commandId), evaluation.result, decidedAt);

      await this.advanceCurrent(decided, previous.revision, decidedAt, session);
      await this.insertRevision(decided, session);
      await this.insertDecision(decision, session);
      if (evaluation.result.outcome === "approved") {
        const commitment = await this.commitReservation(context.organizationId, decided, decision, evaluation.budgets, session);
        if (commitment) {
          await this.syncActionIntent(context, decided, decision, input.meta.commandId, session);
        }
      }

      await this.audit(context, input.meta, requestId, [
        { type: "request.amended", subjectRef: refOfRequest(decided), occurredAt: submittedAt, details: { fromRevision: previous.revision, evaluationState: decided.evaluationState } },
        { type: "decision.recorded", subjectRef: { type: "decision", id: decision.decisionId, revision: 1 }, occurredAt: decidedAt, details: { outcome: decision.outcome, reasonCodes: decision.reasonCodes } },
      ], session);
      return { request: decided, decision };
    });
  }

  async decideReview(context: FinancialContext, input: OperationInput<"reviews.decide">): Promise<{ decision: Decision; commitment: Commitment | null }> {
    this.assertTenant(context, input.meta.organizationId);
    return this.runCommand("reviews.decide", context.organizationId, input.meta, input.payload, async (session) => {
      const { requestId, requestRevision, outcome, rationale } = input.payload;
      const actor = await this.requireAuthority(context, session);
      if (!actor.roles.includes(FINANCE_MANAGER_ROLE)) {
        throw financeErrors.authorityDenied("current finance_manager authority is required to decide a review");
      }
      const current = await this.loadCurrent(context.organizationId, requestId, session);
      if (!current) {
        throw financeErrors.notFound(`request ${requestId} does not exist in this organization`);
      }
      if (current.currentRevision !== requestRevision) {
        throw financeErrors.staleVersion(`request ${requestId} is at revision ${current.currentRevision}, not ${requestRevision}`);
      }
      if (current.evaluationState !== "review_required") {
        throw financeErrors.policyDenied(`request ${requestId} is ${current.evaluationState}, not awaiting review`, { reasonCode: "REQUEST_NOT_AWAITING_REVIEW" });
      }
      const revision = await this.loadRevision(context.organizationId, requestId, requestRevision, session);
      if (!revision) {
        throw financeErrors.staleVersion(`request ${requestId} revision ${requestRevision} is missing`);
      }
      // A human decision is terminal for its revision: a second approval under a new command id
      // must not reserve the same capacity again.
      const terminal = await this.db.collection(DECISIONS_COLLECTION).findOne(
        {
          organizationId: context.organizationId, "requestRef.id": requestId, "requestRef.revision": requestRevision,
          reasonCodes: { $in: ["AUTHORIZED_HUMAN_EXCEPTION", "HUMAN_REVIEW_DENIED"] },
        },
        { session, projection: { decisionId: 1, outcome: 1 } },
      );
      if (terminal) {
        throw financeErrors.policyDenied(`request ${requestId} revision ${requestRevision} already has a human decision`, {
          reasonCode: "REQUEST_ALREADY_DECIDED", decisionId: terminal.decisionId, outcome: terminal.outcome,
        });
      }
      const requesterRoles = await this.requesterRolesFor(context, revision.requesterId, session);
      const decidedAt = this.nowIso();
      const decisionId = this.decisionId(context.organizationId, requestId, requestRevision, input.meta.commandId);
      const policy = await this.loadActivePolicy(context.organizationId, revision, session);
      await this.touchPolicyGuard(context.organizationId, policy, session);

      if (outcome === "denied") {
        const decision = this.decisionFrom(revision, decisionId, {
          outcome: "denied",
          reasonCodes: ["HUMAN_REVIEW_DENIED"],
          policyRef: refOfPolicy(policy),
          authorizationEpoch: policy.authorizationEpoch,
          evaluatedFullAmount: revision.fullAmount,
          evaluatedCumulativeIncrease: revision.cumulativeIncrease,
          factualInputs: [refOfRequest(revision), refOfPolicy(policy)],
          evidenceRefs: [],
          requiredApproverRole: null,
          permittedAction: null,
        }, decidedAt);
        await this.insertDecision(decision, session);
        await this.audit(context, input.meta, requestId, [
          { type: "review.denied", subjectRef: { type: "decision", id: decisionId, revision: 1 }, occurredAt: decidedAt, details: { rationale } },
        ], session);
        return { decision, commitment: await this.loadCommitment(context.organizationId, requestId, session) };
      }

      const grant = this.buildGrant(context, revision, policy, input.meta.commandId);
      const approver = this.approverAuthority(context.organizationId, context.principalId, actor);
      const evaluation = await this.evaluate(context.organizationId, revision, requesterRoles, { grant, approver }, session);
      if (evaluation.result.outcome !== "approved") {
        const reasons = evaluation.result.reasonCodes;
        if (reasons.includes("HARD_CAP_CAPACITY_INSUFFICIENT")) {
          throw financeErrors.capacityExceeded("the reserved amount cannot be absorbed by a binding hard cap", { reasonCodes: reasons });
        }
        if (reasons.includes("EXPLICIT_DENY_RULE")) {
          throw financeErrors.policyDenied("current policy explicitly denies this request", { reasonCodes: reasons });
        }
        throw financeErrors.staleVersion("the approval is no longer valid against current state", { reasonCodes: reasons });
      }

      const decision = this.decisionFrom(revision, decisionId, evaluation.result, decidedAt);
      await this.db.collection(GRANTS_COLLECTION).insertOne({ ...grant }, { session });
      await this.insertDecision(decision, session);
      const commitment = await this.commitReservation(context.organizationId, revision, decision, evaluation.budgets, session);
      if (commitment) {
        await this.syncActionIntent(context, revision, decision, input.meta.commandId, session);
      }
      await this.audit(context, input.meta, requestId, [
        { type: "review.approved", subjectRef: { type: "decision", id: decisionId, revision: 1 }, occurredAt: decidedAt, details: { grantId: grant.grantId, rationale } },
        { type: "decision.recorded", subjectRef: { type: "decision", id: decisionId, revision: 1 }, occurredAt: decidedAt, details: { outcome: decision.outcome, reasonCodes: decision.reasonCodes } },
      ], session);
      return { decision, commitment };
    });
  }

  async recordPosting(context: FinancialContext, input: OperationInput<"postings.record">): Promise<Posting> {
    this.assertTenant(context, input.meta.organizationId);
    return this.runCommand("postings.record", context.organizationId, input.meta, input.payload, async (session) => {
      const actor = await this.requireAuthority(context, session);
      if (!actor.roles.includes(FINANCE_MANAGER_ROLE)) {
        throw financeErrors.authorityDenied("current finance_manager authority is required to record a posting");
      }
      await this.assertExpectedVersions(context.organizationId, input.meta.expectedVersions, session);
      const posting = PostingSchema.parse({ ...input.payload, schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: context.organizationId });
      await applyCanonicalPosting(this.db, posting, session, this.nowIso());
      return posting;
    });
  }

  async correctPosting(context: FinancialContext, input: OperationInput<"postings.correct">): Promise<PostingCorrection> {
    this.assertTenant(context, input.meta.organizationId);
    return this.runCommand("postings.correct", context.organizationId, input.meta, input.payload, async (session) => {
      const actor = await this.requireAuthority(context, session);
      if (!actor.roles.includes(FINANCE_MANAGER_ROLE)) {
        throw financeErrors.authorityDenied("current finance_manager authority is required to correct a posting");
      }
      await this.assertExpectedVersions(context.organizationId, input.meta.expectedVersions, session);
      const correction = PostingCorrectionSchema.parse({ ...input.payload, schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: context.organizationId });
      await applyCanonicalCorrection(this.db, correction, session, this.nowIso());
      return correction;
    });
  }

  async getRequest(organizationId: string, requestId: string): Promise<RequestView | null> {
    const current = await this.loadCurrent(organizationId, requestId, null);
    if (!current) {
      return null;
    }
    const request = await this.loadRevision(organizationId, requestId, current.currentRevision, null);
    if (!request) {
      return null;
    }
    return {
      request,
      decisions: await this.listDecisions(organizationId, requestId),
      commitment: await this.loadCommitment(organizationId, requestId, null),
    };
  }

  async currentActionIntent(organizationId: string, requestId: string): Promise<ActionIntent | null> {
    const document = await this.db.collection(ACTION_INTENTS_COLLECTION).findOne(
      { organizationId, "requestRef.id": requestId, state: { $ne: "canceled" } },
      { projection: { _id: 0 }, sort: { createdAt: -1 } },
    );
    return document === null ? null : ActionIntentSchema.parse(document);
  }

  async listDecisions(organizationId: string, requestId: string): Promise<Decision[]> {
    const documents = await this.db.collection(DECISIONS_COLLECTION).find(
      { organizationId, "requestRef.id": requestId }, { projection: { _id: 0 } },
    ).sort({ decidedAt: 1, decisionId: 1 }).toArray();
    return documents.map((document) => DecisionSchema.parse(document));
  }

  async listApprovalGrants(organizationId: string, requestId: string): Promise<ApprovalGrant[]> {
    const documents = await this.db.collection(GRANTS_COLLECTION).find(
      { organizationId, "requestRef.id": requestId }, { projection: { _id: 0 } },
    ).sort({ grantedAt: 1 }).toArray();
    return documents.map((document) => ApprovalGrantSchema.parse(document));
  }

  async listActionIntents(organizationId: string, requestId: string): Promise<ActionIntent[]> {
    const documents = await this.db.collection(ACTION_INTENTS_COLLECTION).find(
      { organizationId, "requestRef.id": requestId }, { projection: { _id: 0 } },
    ).sort({ createdAt: 1 }).toArray();
    return documents.map((document) => ActionIntentSchema.parse(document));
  }

  async listRequestRevisions(organizationId: string, requestId: string): Promise<PurchaseRequestRevision[]> {
    const documents = await this.db.collection(REQUEST_REVISIONS_COLLECTION).find(
      { organizationId, requestId }, { projection: { _id: 0 } },
    ).sort({ revision: 1 }).toArray();
    return documents.map((document) => PurchaseRequestRevisionSchema.parse(document));
  }

  async getCommitment(organizationId: string, requestId: string): Promise<Commitment | null> {
    return this.loadCommitment(organizationId, requestId, null);
  }

  async getBudgetAccount(organizationId: string, budgetAccountId: string): Promise<BudgetAccount | null> {
    const document = await this.db.collection(BUDGETS_COLLECTION).findOne({ organizationId, budgetAccountId }, { projection: { _id: 0 } });
    return document === null ? null : BudgetAccountSchema.parse(document);
  }

  async listAuditEvents(organizationId: string, requestId: string): Promise<AuditEventDocument[]> {
    const documents = await this.db.collection(AUDIT_EVENTS_COLLECTION)
      .find({ organizationId, requestId }, { projection: { _id: 0 } })
      .sort({ occurredAt: 1, auditEventId: 1 })
      .toArray();
    return documents as unknown as AuditEventDocument[];
  }

  async seed(organizationId: string, seed: FinancialSeed): Promise<void> {
    for (const candidate of seed.policies ?? []) {
      const policy = PolicySchema.parse({ ...candidate, organizationId });
      await this.db.collection(POLICIES_COLLECTION).replaceOne(
        { organizationId, policyId: policy.policyId, revision: policy.revision }, { ...policy }, { upsert: true },
      );
      await this.db.collection(POLICY_GUARDS_COLLECTION).updateOne(
        { organizationId, policyId: policy.policyId },
        {
          $set: { activeRevision: policy.revision, authorizationEpoch: policy.authorizationEpoch },
          $setOnInsert: { mutationCounter: 0 },
        },
        { upsert: true },
      );
    }
    for (const candidate of seed.budgets ?? []) {
      const budget = BudgetAccountSchema.parse({ ...candidate, organizationId });
      await this.db.collection(BUDGETS_COLLECTION).replaceOne({ organizationId, budgetAccountId: budget.budgetAccountId }, { ...budget }, { upsert: true });
    }
    for (const candidate of seed.evidence ?? []) {
      const evidence = EvidenceSchema.parse({ ...candidate, organizationId });
      await this.db.collection(EVIDENCE_COLLECTION).replaceOne(
        { organizationId, evidenceId: evidence.evidenceId, revision: evidence.revision }, { ...evidence }, { upsert: true },
      );
    }
    for (const candidate of seed.purposes ?? []) {
      await this.db.collection(PURPOSES_COLLECTION).replaceOne(
        { organizationId, purpose: candidate.purpose },
        { organizationId, purpose: candidate.purpose, revision: 1, active: candidate.active, ...(candidate.ref ? { ref: candidate.ref } : {}) },
        { upsert: true },
      );
    }
    for (const candidate of seed.authorities ?? []) {
      await this.db.collection(PRINCIPAL_AUTHORITIES_COLLECTION).replaceOne(
        { organizationId, principalId: candidate.principalId },
        {
          organizationId, principalId: candidate.principalId, revision: 1, roles: [...candidate.roles],
          scopes: candidate.scopes.map((scope) => ({ ...scope })), revoked: candidate.revoked ?? false,
        },
        { upsert: true },
      );
    }
  }

  // --- internals -----------------------------------------------------------------------------

  private assertTenant(context: FinancialContext, organizationId: string): void {
    if (context.organizationId !== organizationId) {
      throw financeErrors.authorityDenied("the command organization does not match the authenticated tenant");
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private provenance(sourceObjectId: string, sourceRevision: string, at: string) {
    return {
      kind: "synthetic" as const,
      trust: "authoritative" as const,
      sourceInstanceId: "source_api_command",
      sourceObjectId,
      sourceRevision,
      occurredAt: at,
      observedAt: at,
    };
  }

  private decisionId(organizationId: string, requestId: string, revision: number, commandId: string): string {
    return recordId("decision", organizationId, requestId, revision, commandId);
  }

  private async runCommand<T>(
    operation: string,
    organizationId: string,
    meta: CommandMeta,
    payload: unknown,
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const commandFingerprint = fingerprint({
      operation,
      organizationId,
      payload,
      expectedVersions: meta.expectedVersions,
      causationId: meta.causationId ?? null,
    });
    const commands = this.db.collection<CommandDocument>(COMMANDS_COLLECTION);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.withTransaction(async (session) => {
          const claimed = await commands.findOneAndUpdate(
            { organizationId, commandId: meta.commandId },
            {
              $setOnInsert: {
                organizationId, commandId: meta.commandId, fingerprint: commandFingerprint,
                operation, correlationId: meta.correlationId, claimedAt: this.nowIso(),
              },
            },
            { upsert: true, returnDocument: "after", session },
          );
          if (!claimed) {
            throw financeErrors.dependencyUnavailable("command claim vanished during the transaction");
          }
          if (claimed.fingerprint !== commandFingerprint) {
            throw financeErrors.idempotencyConflict(`command ${meta.commandId} was already used with a different payload`, { commandId: meta.commandId });
          }
          if (claimed.response !== undefined) {
            return claimed.response as T;
          }
          const response = await work(session);
          await commands.updateOne(
            { organizationId, commandId: meta.commandId },
            { $set: { response: response as Record<string, unknown>, appliedAt: this.nowIso() } },
            { session },
          );
          return response;
        });
      } catch (error) {
        if (isCommandClaimRace(error)) {
          continue;
        }
        throw error;
      }
    }
    throw financeErrors.dependencyUnavailable("command contention exceeded the retry budget");
  }

  private async requireAuthority(context: FinancialContext, session: ClientSession): Promise<ResolvedAuthority> {
    const resolved = await this.resolveAuthority(context.organizationId, context.principalId, session);
    if (resolved.revoked) {
      throw financeErrors.authorityDenied("the principal's authority has been revoked");
    }
    return resolved;
  }

  private async resolveAuthority(organizationId: string, principalId: string, session: ClientSession | null): Promise<ResolvedAuthority> {
    const document = await this.db.collection<PrincipalAuthorityDocument>(PRINCIPAL_AUTHORITIES_COLLECTION)
      .findOne({ organizationId, principalId }, { ...(session ? { session } : {}), projection: { _id: 0 } });
    if (!document) {
      throw financeErrors.authorityDenied(`no authority record for ${principalId} in this organization`);
    }
    return { roles: [...document.roles], scopes: document.scopes.map((scope) => ({ ...scope })), revoked: document.revoked };
  }

  private approverAuthority(organizationId: string, approverId: string, authority: ResolvedAuthority): ApproverAuthority {
    return {
      organizationId,
      approverId,
      roles: [...authority.roles],
      scopes: authority.scopes.map((scope) => ({ ...scope })),
      revoked: authority.revoked,
    };
  }

  /** Trusted requester roles come from the backend authority record, never from request text. */
  private async requesterRolesFor(context: FinancialContext, requesterId: string, session: ClientSession): Promise<string[]> {
    return (await this.resolveAuthority(context.organizationId, requesterId, session)).roles;
  }

  private async assertExpectedVersions(organizationId: string, expectations: CommandMeta["expectedVersions"], session: ClientSession): Promise<void> {
    for (const candidate of expectations) {
      const expectation = VersionExpectationSchema.parse(candidate);
      const current = await this.currentRevisionOf(organizationId, expectation.ref, session);
      if (current === null) {
        throw financeErrors.staleVersion(`expectedVersions references ${expectation.ref.type} ${expectation.ref.id}, which is not current`);
      }
      if (current !== expectation.expectedRevision) {
        throw financeErrors.staleVersion(
          `${expectation.ref.type} ${expectation.ref.id} is at revision ${current}, not ${expectation.expectedRevision}`,
          { ref: expectation.ref, expectedRevision: expectation.expectedRevision, currentRevision: current },
        );
      }
    }
  }

  private async currentRevisionOf(organizationId: string, ref: { type: string; id: string }, session: ClientSession): Promise<number | null> {
    switch (ref.type) {
      case "request": {
        const document = await this.db.collection<RequestCurrentDocument>(REQUEST_CURRENT_COLLECTION).findOne({ organizationId, requestId: ref.id }, { session, projection: { currentRevision: 1 } });
        return document?.currentRevision ?? null;
      }
      case "policy": {
        const document = await this.db.collection<PolicyGuardDocument>(POLICY_GUARDS_COLLECTION).findOne({ organizationId, policyId: ref.id }, { session, projection: { activeRevision: 1 } });
        return document?.activeRevision ?? null;
      }
      case "budget_account": {
        const document = await this.db.collection(BUDGETS_COLLECTION).findOne({ organizationId, budgetAccountId: ref.id }, { session, projection: { revision: 1 } });
        return (document?.revision as number | undefined) ?? null;
      }
      case "commitment": {
        const document = await this.db.collection(COMMITMENTS_COLLECTION).findOne({ organizationId, commitmentId: ref.id }, { session, projection: { revision: 1 } });
        return (document?.revision as number | undefined) ?? null;
      }
      case "action_intent": {
        const document = await this.db.collection(ACTION_INTENTS_COLLECTION).findOne({ organizationId, actionIntentId: ref.id }, { session, projection: { revision: 1 } });
        return (document?.revision as number | undefined) ?? null;
      }
      default:
        return null;
    }
  }

  private async loadCurrent(organizationId: string, requestId: string, session: ClientSession | null): Promise<RequestCurrentDocument | null> {
    const document = await this.db.collection<RequestCurrentDocument>(REQUEST_CURRENT_COLLECTION)
      .findOne({ organizationId, requestId }, { ...(session ? { session } : {}), projection: { _id: 0 } });
    return document ?? null;
  }

  private async loadRevision(organizationId: string, requestId: string, revision: number, session: ClientSession | null): Promise<PurchaseRequestRevision | null> {
    const document = await this.db.collection(REQUEST_REVISIONS_COLLECTION)
      .findOne({ organizationId, requestId, revision }, { ...(session ? { session } : {}), projection: { _id: 0 } });
    return document === null ? null : PurchaseRequestRevisionSchema.parse(document);
  }

  private async loadCommitment(organizationId: string, requestId: string, session: ClientSession | null): Promise<Commitment | null> {
    const document = await this.db.collection(COMMITMENTS_COLLECTION)
      .findOne({ organizationId, "requestRef.id": requestId }, { ...(session ? { session } : {}), projection: { _id: 0 } });
    return document === null ? null : CommitmentSchema.parse(document);
  }

  private async insertRevision(revision: PurchaseRequestRevision, session: ClientSession): Promise<void> {
    await this.db.collection(REQUEST_REVISIONS_COLLECTION).insertOne({ ...revision }, { session });
  }

  private async insertDecision(decision: Decision, session: ClientSession): Promise<void> {
    await this.db.collection(DECISIONS_COLLECTION).insertOne({ ...decision }, { session });
  }

  private async advanceCurrent(revision: PurchaseRequestRevision, fromRevision: number, updatedAt: string, session: ClientSession): Promise<void> {
    const result = await this.db.collection(REQUEST_CURRENT_COLLECTION).updateOne(
      { organizationId: revision.organizationId, requestId: revision.requestId, currentRevision: fromRevision },
      {
        $set: {
          currentRevision: revision.revision,
          evaluationState: revision.evaluationState,
          cumulativeIncrease: revision.cumulativeIncrease,
          updatedAt,
        },
      },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw financeErrors.staleVersion(`request ${revision.requestId} advanced concurrently`);
    }
  }

  /**
   * Conditional guard update that serializes a financial mutation against a
   * concurrent policy publication. A changed active revision or epoch fails the
   * write so the transaction retries against the new policy.
   */
  private async touchPolicyGuard(organizationId: string, policy: Policy, session: ClientSession): Promise<void> {
    const result = await this.db.collection(POLICY_GUARDS_COLLECTION).updateOne(
      { organizationId, policyId: policy.policyId, activeRevision: policy.revision, authorizationEpoch: policy.authorizationEpoch },
      { $inc: { mutationCounter: 1 } },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw financeErrors.staleVersion(`policy ${policy.policyId} changed during the transaction`);
    }
  }

  private async loadActivePolicy(organizationId: string, request: PurchaseRequestRevision, session: ClientSession): Promise<Policy> {
    const guards = await this.db.collection<PolicyGuardDocument>(POLICY_GUARDS_COLLECTION)
      .find({ organizationId }, { ...(session ? { session } : {}), projection: { _id: 0 } })
      .toArray();
    const candidates: Array<{ policy: Policy; specific: boolean }> = [];
    for (const guard of guards) {
      const document = await this.db.collection(POLICIES_COLLECTION)
        .findOne({ organizationId, policyId: guard.policyId, revision: guard.activeRevision }, { ...(session ? { session } : {}), projection: { _id: 0 } });
      if (!document) {
        continue;
      }
      const policy = PolicySchema.parse(document);
      if (policyScopeCovers(policy.scope, request)) {
        candidates.push({ policy, specific: policy.scope.type !== "organization" });
      }
    }
    if (candidates.length === 0) {
      throw financeErrors.dependencyUnavailable("no active policy covers this organization");
    }
    candidates.sort((left, right) => Number(right.specific) - Number(left.specific) || (left.policy.policyId < right.policy.policyId ? -1 : 1));
    return candidates[0]!.policy;
  }

  private async evaluate(
    organizationId: string,
    revision: PurchaseRequestRevision,
    requesterRoles: readonly string[],
    grant: GrantContext | undefined,
    session: ClientSession,
  ): Promise<{ result: PolicyEvaluationResult; budgets: BudgetAccount[] }> {
    const evaluatedAt = this.nowIso();
    const policy = await this.loadActivePolicy(organizationId, revision, session);
    await this.touchPolicyGuard(organizationId, policy, session);
    const purpose = await this.loadPurpose(organizationId, revision.purpose, session);
    const evidence = await this.loadEvidence(organizationId, policy, revision, session);
    const cumulativeTotals = await this.computeCumulativeTotals(organizationId, revision, session);
    const delta = revision.previousRevision === null ? revision.fullAmount.amountMinor : revision.increaseFromPrevious.amountMinor;
    const accounts = await resolveBindingBudgets(this.db, organizationId, requestBudgetScopes(revision), evaluatedAt, session);
    const bindings: BindingBudgetInput[] = accounts.map((account) => ({ account, reserveDelta: usd(delta) }));

    let result = evaluateRequestPolicy({
      evaluatedAt,
      request: revision,
      policy,
      requesterRoles: [...requesterRoles],
      purpose,
      cumulativeTotals,
      evidence,
      budgets: bindings,
      ...(grant ? { grant } : {}),
    } satisfies PolicyEvaluationInput);

    // Execution needs at least one binding account: the commitment contract requires a reference.
    if (result.outcome === "approved" && accounts.length === 0) {
      result = {
        ...result,
        outcome: "review_required",
        reasonCodes: [...new Set([...result.reasonCodes, REASON_CODE.MISSING_TRUSTED_FACTS])].sort(),
        permittedAction: null,
        requiredApproverRole: result.requiredApproverRole ?? FINANCE_MANAGER_ROLE,
      };
    }
    return { result, budgets: accounts };
  }

  private async loadPurpose(organizationId: string, purpose: string, session: ClientSession): Promise<TrustedPurposeState | null> {
    const document = await this.db.collection<PurposeDocument>(PURPOSES_COLLECTION)
      .findOne({ organizationId, purpose }, { ...(session ? { session } : {}), projection: { _id: 0 } });
    if (!document) {
      return null;
    }
    return { purpose: document.purpose, active: document.active, ...(document.ref ? { ref: document.ref } : {}) };
  }

  /** Evidence may satisfy a rule only when its access scope covers the request's scopes. */
  private async loadEvidence(organizationId: string, policy: Policy, revision: PurchaseRequestRevision, session: ClientSession): Promise<Evidence[]> {
    const kinds = [...new Set(policy.rules.flatMap((rule) => rule.requiredEvidenceKinds))];
    if (kinds.length === 0) {
      return [];
    }
    const documents = await this.db.collection(EVIDENCE_COLLECTION)
      .find({ organizationId, kind: { $in: kinds } }, { ...(session ? { session } : {}), projection: { _id: 0 } })
      .toArray();
    return documents
      .map((document) => EvidenceSchema.parse(document))
      .filter((evidence) => evidenceEligible(evidence, organizationId, revision.scopes));
  }

  private async computeCumulativeTotals(organizationId: string, revision: PurchaseRequestRevision, session: ClientSession): Promise<CumulativeTotalInput[]> {
    const others = await this.db.collection<RequestCurrentDocument>(REQUEST_CURRENT_COLLECTION).find(
      {
        organizationId,
        requestId: { $ne: revision.requestId },
        evaluationState: { $ne: "denied" },
        $or: [
          { purpose: revision.purpose },
          { requesterId: revision.requesterId },
          ...(revision.projectId === undefined ? [] : [{ projectId: revision.projectId }]),
        ],
      },
      { ...(session ? { session } : {}), projection: { _id: 0 } },
    ).toArray();

    const totals: CumulativeTotalInput[] = [];
    const add = (dimension: "employee" | "purpose" | "project", dimensionId: string, matches: (candidate: RequestCurrentDocument) => boolean) => {
      const matched = others.filter(matches);
      const consumed = matched.reduce((sum, candidate) => sum + candidate.cumulativeIncrease.amountMinor, 0);
      totals.push({
        dimension,
        dimensionId,
        cumulativeIncrease: usd(revision.cumulativeIncrease.amountMinor + consumed),
        sources: [
          refOfRequest(revision),
          ...matched.map((candidate) => ({ type: "request", id: candidate.requestId, revision: candidate.currentRevision })),
        ],
      });
    };
    add("purpose", revision.purpose, (candidate) => candidate.purpose === revision.purpose);
    add("employee", revision.requesterId, (candidate) => candidate.requesterId === revision.requesterId);
    if (revision.projectId !== undefined) {
      add("project", revision.projectId, (candidate) => candidate.projectId === revision.projectId);
    }
    return totals;
  }

  private decisionFrom(revision: PurchaseRequestRevision, decisionId: string, result: DecisionFields, decidedAt: string): Decision {
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      organizationId: revision.organizationId,
      decisionId,
      requestRef: refOfRequest(revision),
      outcome: result.outcome,
      reasonCodes: result.reasonCodes,
      policyRef: result.policyRef,
      authorizationEpoch: result.authorizationEpoch,
      evaluatedFullAmount: result.evaluatedFullAmount,
      evaluatedCumulativeIncrease: result.evaluatedCumulativeIncrease,
      factualInputs: result.factualInputs,
      evidenceRefs: result.evidenceRefs,
      requiredApproverRole: result.requiredApproverRole,
      ...(result.approvalGrantRef === undefined ? {} : { approvalGrantRef: result.approvalGrantRef }),
      permittedAction: result.permittedAction,
      decidedAt,
    };
  }

  private buildGrant(context: FinancialContext, revision: PurchaseRequestRevision, policy: Policy, commandId: string): ApprovalGrant {
    const scope = revision.scopes.find((candidate) => candidate.type !== "organization")
      ?? revision.scopes.find((candidate) => candidate.type === "organization")!;
    const grantedAt = this.now();
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      organizationId: context.organizationId,
      grantId: recordId("grant", context.organizationId, revision.requestId, revision.revision, commandId),
      requestRef: refOfRequest(revision),
      approverId: context.principalId,
      authorityRole: FINANCE_MANAGER_ROLE,
      actionType: approvalActionTypeFor(revision),
      exactAmount: revision.fullAmount,
      policyRef: refOfPolicy(policy),
      authorizationEpoch: policy.authorizationEpoch,
      scope: { ...scope },
      grantedAt: grantedAt.toISOString(),
      expiresAt: new Date(grantedAt.getTime() + APPROVAL_GRANT_TTL_MS).toISOString(),
    };
  }

  /**
   * Creates or advances the request's single commitment. An amendment adds only
   * its increase to the outstanding amount while recording the revised full amount.
   */
  private async commitReservation(
    organizationId: string,
    revision: PurchaseRequestRevision,
    decision: Decision,
    accounts: readonly BudgetAccount[],
    session: ClientSession,
  ): Promise<Commitment | null> {
    const delta = revision.previousRevision === null ? revision.fullAmount.amountMinor : revision.increaseFromPrevious.amountMinor;
    const updatedAccounts = await applyExposure(this.db, accounts, { recognized: 0, outstanding: delta }, { enforceHardCap: true }, session);
    const existing = await this.loadCommitment(organizationId, revision.requestId, session);
    if (!existing && updatedAccounts.length === 0) {
      return null;
    }
    const budgetAccountRefs = updatedAccounts.length > 0 ? updatedAccounts.map(budgetRefOf) : existing!.budgetAccountRefs;
    const decisionRef = { type: "decision", id: decision.decisionId, revision: 1 };
    if (existing) {
      const outstanding = usd(existing.outstandingAmount.amountMinor + delta);
      const next: Commitment = {
        ...existing,
        revision: existing.revision + 1,
        requestRef: refOfRequest(revision),
        decisionRef,
        amount: revision.fullAmount,
        outstandingAmount: outstanding,
        state: outstanding.amountMinor === 0 ? "posted" : "outstanding",
        budgetAccountRefs,
      };
      const result = await this.db.collection(COMMITMENTS_COLLECTION).updateOne(
        { organizationId, commitmentId: existing.commitmentId, revision: existing.revision },
        { $set: next },
        { session },
      );
      if (result.matchedCount !== 1) {
        throw financeErrors.staleVersion(`commitment for ${revision.requestId} changed during the transaction`);
      }
      return CommitmentSchema.parse(next);
    }
    const commitment: Commitment = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      organizationId,
      commitmentId: recordId("commitment", organizationId, revision.requestId),
      revision: 1,
      requestRef: refOfRequest(revision),
      decisionRef,
      amount: revision.fullAmount,
      outstandingAmount: usd(delta),
      state: "outstanding",
      budgetAccountRefs,
      createdAt: decision.decidedAt,
    };
    await this.db.collection(COMMITMENTS_COLLECTION).insertOne({ ...commitment }, { session });
    return commitment;
  }

  private async assertIntentAmendable(organizationId: string, requestId: string, session: ClientSession): Promise<void> {
    const locked = await this.db.collection(ACTION_INTENTS_COLLECTION).findOne(
      { organizationId, "requestRef.id": requestId, state: { $in: ["dispatching", "succeeded", "failed", "outcome_unknown"] } },
      { session, projection: { actionIntentId: 1, state: 1 } },
    );
    if (locked) {
      throw financeErrors.staleVersion(`request ${requestId} has an action in state ${String(locked.state)} and cannot be amended`, {
        actionIntentId: locked.actionIntentId,
        state: locked.state,
      });
    }
  }

  /**
   * Enforces one executable pending intent per request: older pending intents are
   * canceled and a single full-amount intent for the latest revision is created.
   */
  private async syncActionIntent(context: FinancialContext, revision: PurchaseRequestRevision, decision: Decision, commandId: string, session: ClientSession): Promise<void> {
    if (revision.vendorId === undefined) {
      return;
    }
    const intents = this.db.collection(ACTION_INTENTS_COLLECTION);
    const pending = await intents.find(
      { organizationId: context.organizationId, "requestRef.id": revision.requestId, state: "pending" },
      { ...(session ? { session } : {}), projection: { _id: 0 } },
    ).toArray();
    for (const document of pending) {
      const intent = ActionIntentSchema.parse(document);
      if (intent.requestRef.revision === revision.revision) {
        continue;
      }
      const result = await intents.updateOne(
        { organizationId: context.organizationId, actionIntentId: intent.actionIntentId, revision: intent.revision },
        { $set: { state: "canceled", revision: intent.revision + 1 } },
        { session },
      );
      if (result.matchedCount !== 1) {
        throw financeErrors.staleVersion(`action intent ${intent.actionIntentId} changed during the transaction`);
      }
    }
    const intentId = recordId("action", context.organizationId, revision.requestId, revision.revision);
    const existing = await intents.findOne({ organizationId: context.organizationId, actionIntentId: intentId }, { ...(session ? { session } : {}), projection: { _id: 0 } });
    if (existing) {
      return;
    }
    await intents.insertOne({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      organizationId: context.organizationId,
      actionIntentId: intentId,
      revision: 1,
      requestRef: refOfRequest(revision),
      decisionRef: { type: "decision", id: decision.decisionId, revision: 1 },
      commandId,
      providerInstanceId: "provider_simulated_spend",
      idempotencyKey: `${context.organizationId}:${revision.requestId}:${revision.revision}`,
      action: { type: "simulate_purchase", amount: revision.fullAmount, vendorId: revision.vendorId },
      state: "pending",
      createdAt: this.nowIso(),
    }, { session });
  }

  private async audit(context: FinancialContext, meta: CommandMeta, requestId: string, events: readonly AuditDraft[], session: ClientSession): Promise<void> {
    await appendAuditEvents(
      this.db,
      context.organizationId,
      meta.commandId,
      events.map((event) => ({
        ...event,
        requestId,
        actorId: context.principalId,
        actorRoles: context.roles,
        commandId: meta.commandId,
        correlationId: meta.correlationId,
      })),
      session,
    );
  }
}

function evidenceEligible(evidence: Evidence, organizationId: string, requestScopes: PurchaseRequestRevision["scopes"]): boolean {
  return evidence.access.scopeRefs.some((scope) =>
    (scope.type === "organization" && scope.id === organizationId)
    || requestScopes.some((candidate) => candidate.type === scope.type && candidate.id === scope.id));
}

function policyScopeCovers(scope: { type: string; id: string }, request: PurchaseRequestRevision): boolean {
  if (scope.type === "organization") {
    return scope.id === request.organizationId;
  }
  return request.scopes.some((candidate) => candidate.type === scope.type && candidate.id === scope.id);
}

function isCommandClaimRace(error: unknown): boolean {
  return typeof (error as { message?: unknown } | null)?.message === "string"
    && (error as { message: string }).message.includes("command_identity");
}
