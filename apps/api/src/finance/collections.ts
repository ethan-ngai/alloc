import { CONTRACT_SCHEMA_VERSION } from "@alloc/contracts";
import type { Db } from "mongodb";
import {
  ACCESS, DATE, ID, NON_EMPTY_STRING, NON_NEGATIVE_INT, NON_NEGATIVE_MONEY, ORG_ID, POLICY_RULE,
  POSITIVE_MONEY, PROVENANCE, RECORD_REF, REVISION, REVISION_OR_NULL, SCOPES, SCOPE_REF, SIGNED_INT, SIGNED_MONEY,
  SIGNED_NON_ZERO_MONEY, TIMESTAMP, TIMESTAMP_OR_NULL, ensureCollections, schema, type CollectionSpec,
} from "../mongo/collections.js";

export const POLICIES_COLLECTION = "financial_policies";
export const POLICY_GUARDS_COLLECTION = "financial_policy_guards";
export const PRINCIPAL_AUTHORITIES_COLLECTION = "financial_principal_authorities";
export const PURPOSES_COLLECTION = "financial_purposes";
export const EVIDENCE_COLLECTION = "financial_evidence";
export const REQUEST_REVISIONS_COLLECTION = "financial_request_revisions";
export const REQUEST_CURRENT_COLLECTION = "financial_request_current";
export const BUDGETS_COLLECTION = "financial_budgets";
export const COMMITMENTS_COLLECTION = "financial_commitments";
export const GRANTS_COLLECTION = "financial_grants";
export const DECISIONS_COLLECTION = "financial_decisions";
export const ACTION_INTENTS_COLLECTION = "financial_action_intents";
export const COMMANDS_COLLECTION = "financial_commands";
export const POSTINGS_COLLECTION = "financial_postings";
export const CORRECTIONS_COLLECTION = "financial_corrections";
export const AUDIT_EVENTS_COLLECTION = "financial_audit_events";

const SPECS: readonly CollectionSpec[] = [
  {
    name: POLICIES_COLLECTION,
    validator: schema(
      ["schemaVersion", "organizationId", "policyId", "revision", "authorizationEpoch", "name", "scope", "effectiveFrom", "effectiveTo", "rules", "publishedBy"],
      {
        schemaVersion: { enum: [CONTRACT_SCHEMA_VERSION] }, organizationId: ORG_ID, policyId: ID, revision: REVISION,
        authorizationEpoch: REVISION, name: NON_EMPTY_STRING, scope: SCOPE_REF, effectiveFrom: TIMESTAMP,
        effectiveTo: TIMESTAMP_OR_NULL, rules: { bsonType: "array", minItems: 1, items: POLICY_RULE }, publishedBy: ID,
      },
    ),
    indexes: [
      { key: { organizationId: 1, policyId: 1, revision: 1 }, name: "policy_identity", unique: true },
    ],
  },
  {
    name: POLICY_GUARDS_COLLECTION,
    validator: schema(
      ["organizationId", "policyId", "activeRevision", "authorizationEpoch", "mutationCounter"],
      { organizationId: ORG_ID, policyId: ID, activeRevision: REVISION, authorizationEpoch: REVISION, mutationCounter: NON_NEGATIVE_INT },
    ),
    indexes: [{ key: { organizationId: 1, policyId: 1 }, name: "guard_identity", unique: true }],
  },
  {
    name: PRINCIPAL_AUTHORITIES_COLLECTION,
    validator: schema(
      ["organizationId", "principalId", "revision", "roles", "scopes", "revoked"],
      {
        organizationId: ORG_ID, principalId: ID, revision: REVISION,
        roles: { bsonType: "array", minItems: 1, items: NON_EMPTY_STRING }, scopes: SCOPES, revoked: { bsonType: "bool" },
      },
    ),
    indexes: [{ key: { organizationId: 1, principalId: 1 }, name: "authority_identity", unique: true }],
  },
  {
    name: PURPOSES_COLLECTION,
    validator: schema(
      ["organizationId", "purpose", "revision", "active"],
      { organizationId: ORG_ID, purpose: NON_EMPTY_STRING, revision: REVISION, active: { bsonType: "bool" }, ref: RECORD_REF },
    ),
    indexes: [{ key: { organizationId: 1, purpose: 1 }, name: "purpose_identity", unique: true }],
  },
  {
    name: EVIDENCE_COLLECTION,
    validator: schema(
      ["schemaVersion", "organizationId", "evidenceId", "revision", "kind", "title", "content", "access", "provenance", "authoritativeFor"],
      {
        schemaVersion: { enum: [CONTRACT_SCHEMA_VERSION] }, organizationId: ORG_ID, evidenceId: ID, revision: REVISION,
        kind: { enum: ["source_record", "document_excerpt", "metric", "decision_precedent"] }, title: NON_EMPTY_STRING,
        content: NON_EMPTY_STRING, access: ACCESS, provenance: PROVENANCE,
        authoritativeFor: { bsonType: "array", items: NON_EMPTY_STRING },
      },
    ),
    indexes: [
      { key: { organizationId: 1, evidenceId: 1, revision: 1 }, name: "evidence_identity", unique: true },
      { key: { organizationId: 1, kind: 1 }, name: "evidence_kind" },
    ],
  },
  {
    name: REQUEST_REVISIONS_COLLECTION,
    validator: schema(
      ["schemaVersion", "organizationId", "requestId", "revision", "previousRevision", "requesterId", "purpose", "fullAmount", "increaseFromPrevious", "cumulativeIncrease", "categoryId", "scopes", "evaluationState", "submittedAt", "provenance"],
      {
        schemaVersion: { enum: [CONTRACT_SCHEMA_VERSION] }, organizationId: ORG_ID, requestId: ID, revision: REVISION,
        previousRevision: REVISION_OR_NULL, requesterId: ID, purpose: NON_EMPTY_STRING, fullAmount: POSITIVE_MONEY,
        increaseFromPrevious: NON_NEGATIVE_MONEY, cumulativeIncrease: NON_NEGATIVE_MONEY, categoryId: ID, vendorId: ID,
        projectId: ID, scopes: SCOPES, evaluationState: { enum: ["submitted", "evaluating", "approved", "review_required", "denied"] },
        submittedAt: TIMESTAMP, provenance: PROVENANCE,
      },
    ),
    indexes: [
      { key: { organizationId: 1, requestId: 1, revision: 1 }, name: "revision_identity", unique: true },
      { key: { organizationId: 1, requestId: 1 }, name: "revision_history" },
    ],
  },
  {
    name: REQUEST_CURRENT_COLLECTION,
    validator: schema(
      ["organizationId", "requestId", "currentRevision", "evaluationState", "requesterId", "purpose", "cumulativeIncrease", "updatedAt"],
      {
        organizationId: ORG_ID, requestId: ID, currentRevision: REVISION,
        evaluationState: { enum: ["submitted", "evaluating", "approved", "review_required", "denied"] },
        requesterId: ID, purpose: NON_EMPTY_STRING, projectId: ID, cumulativeIncrease: NON_NEGATIVE_MONEY, updatedAt: TIMESTAMP,
      },
    ),
    indexes: [
      { key: { organizationId: 1, requestId: 1 }, name: "current_identity", unique: true },
      { key: { organizationId: 1, purpose: 1 }, name: "current_purpose" },
      { key: { organizationId: 1, requesterId: 1 }, name: "current_requester" },
      { key: { organizationId: 1, projectId: 1 }, name: "current_project" },
    ],
  },
  {
    name: BUDGETS_COLLECTION,
    validator: schema(
      ["schemaVersion", "organizationId", "budgetAccountId", "revision", "scope", "authorized", "recognizedSpend", "outstandingCommitments", "available", "hardCap", "periodStart", "periodEnd"],
      {
        schemaVersion: { enum: [CONTRACT_SCHEMA_VERSION] }, organizationId: ORG_ID, budgetAccountId: ID, revision: REVISION,
        scope: SCOPE_REF, authorized: NON_NEGATIVE_MONEY, recognizedSpend: NON_NEGATIVE_MONEY,
        outstandingCommitments: NON_NEGATIVE_MONEY, available: SIGNED_MONEY, hardCap: { bsonType: "bool" },
        periodStart: DATE, periodEnd: DATE,
      },
    ),
    indexes: [
      { key: { organizationId: 1, budgetAccountId: 1 }, name: "budget_identity", unique: true },
      { key: { organizationId: 1, "scope.type": 1, "scope.id": 1 }, name: "budget_scope" },
    ],
  },
  {
    name: COMMITMENTS_COLLECTION,
    validator: schema(
      ["schemaVersion", "organizationId", "commitmentId", "revision", "requestRef", "decisionRef", "amount", "outstandingAmount", "state", "budgetAccountRefs", "createdAt"],
      {
        schemaVersion: { enum: [CONTRACT_SCHEMA_VERSION] }, organizationId: ORG_ID, commitmentId: ID, revision: REVISION,
        requestRef: RECORD_REF, decisionRef: RECORD_REF, amount: POSITIVE_MONEY, outstandingAmount: NON_NEGATIVE_MONEY,
        state: { enum: ["outstanding", "partially_posted", "posted", "canceled"] },
        budgetAccountRefs: { bsonType: "array", minItems: 1, items: RECORD_REF }, createdAt: TIMESTAMP,
      },
    ),
    indexes: [
      { key: { organizationId: 1, commitmentId: 1 }, name: "commitment_identity", unique: true },
      { key: { organizationId: 1, "requestRef.id": 1 }, name: "commitment_request", unique: true },
    ],
  },
  {
    name: GRANTS_COLLECTION,
    validator: schema(
      ["schemaVersion", "organizationId", "grantId", "requestRef", "approverId", "authorityRole", "actionType", "exactAmount", "policyRef", "authorizationEpoch", "scope", "grantedAt", "expiresAt"],
      {
        schemaVersion: { enum: [CONTRACT_SCHEMA_VERSION] }, organizationId: ORG_ID, grantId: ID, requestRef: RECORD_REF,
        approverId: ID, authorityRole: NON_EMPTY_STRING, actionType: { enum: ["approve_request", "approve_amendment", "cancel_commitment"] },
        exactAmount: POSITIVE_MONEY, policyRef: RECORD_REF, authorizationEpoch: REVISION, scope: SCOPE_REF,
        grantedAt: TIMESTAMP, expiresAt: TIMESTAMP,
      },
    ),
    indexes: [
      { key: { organizationId: 1, grantId: 1 }, name: "grant_identity", unique: true },
      { key: { organizationId: 1, "requestRef.id": 1 }, name: "grant_request" },
    ],
  },
  {
    name: DECISIONS_COLLECTION,
    validator: schema(
      ["schemaVersion", "organizationId", "decisionId", "requestRef", "outcome", "reasonCodes", "policyRef", "authorizationEpoch", "evaluatedFullAmount", "evaluatedCumulativeIncrease", "factualInputs", "evidenceRefs", "requiredApproverRole", "permittedAction", "decidedAt"],
      {
        schemaVersion: { enum: [CONTRACT_SCHEMA_VERSION] }, organizationId: ORG_ID, decisionId: ID, requestRef: RECORD_REF,
        outcome: { enum: ["approved", "review_required", "denied"] },
        reasonCodes: { bsonType: "array", minItems: 1, items: NON_EMPTY_STRING }, policyRef: RECORD_REF,
        authorizationEpoch: REVISION, evaluatedFullAmount: POSITIVE_MONEY, evaluatedCumulativeIncrease: NON_NEGATIVE_MONEY,
        factualInputs: { bsonType: "array", items: RECORD_REF }, evidenceRefs: { bsonType: "array", items: RECORD_REF },
        requiredApproverRole: { anyOf: [NON_EMPTY_STRING, { bsonType: "null" }] }, approvalGrantRef: RECORD_REF,
        permittedAction: {
          anyOf: [
            { bsonType: "null" },
            {
              bsonType: "object", additionalProperties: false, required: ["type", "amount"],
              properties: { type: { enum: ["simulate_purchase"] }, amount: POSITIVE_MONEY },
            },
          ],
        },
        decidedAt: TIMESTAMP,
      },
    ),
    indexes: [
      { key: { organizationId: 1, decisionId: 1 }, name: "decision_identity", unique: true },
      { key: { organizationId: 1, "requestRef.id": 1 }, name: "decision_request" },
    ],
  },
  {
    name: ACTION_INTENTS_COLLECTION,
    validator: schema(
      ["schemaVersion", "organizationId", "actionIntentId", "revision", "requestRef", "decisionRef", "commandId", "providerInstanceId", "idempotencyKey", "action", "state", "createdAt"],
      {
        schemaVersion: { enum: [CONTRACT_SCHEMA_VERSION] }, organizationId: ORG_ID, actionIntentId: ID, revision: REVISION,
        requestRef: RECORD_REF, decisionRef: RECORD_REF, commandId: ID, providerInstanceId: ID,
        idempotencyKey: NON_EMPTY_STRING,
        action: {
          bsonType: "object", additionalProperties: false, required: ["type", "amount", "vendorId"],
          properties: { type: { enum: ["simulate_purchase"] }, amount: POSITIVE_MONEY, vendorId: ID },
        },
        state: { enum: ["pending", "dispatching", "succeeded", "failed", "outcome_unknown", "canceled"] },
        createdAt: TIMESTAMP,
      },
    ),
    indexes: [
      { key: { organizationId: 1, actionIntentId: 1 }, name: "intent_identity", unique: true },
      { key: { organizationId: 1, "requestRef.id": 1, state: 1 }, name: "intent_request_state" },
    ],
  },
  {
    name: COMMANDS_COLLECTION,
    validator: schema(
      ["organizationId", "commandId", "fingerprint", "operation", "correlationId", "claimedAt"],
      {
        organizationId: ORG_ID, commandId: ID, fingerprint: NON_EMPTY_STRING, operation: NON_EMPTY_STRING,
        response: { bsonType: "object" }, correlationId: ID, appliedAt: TIMESTAMP,
        claimedAt: TIMESTAMP,
      },
    ),
    indexes: [{ key: { organizationId: 1, commandId: 1 }, name: "command_identity", unique: true }],
  },
  {
    name: POSTINGS_COLLECTION,
    validator: schema(
      ["schemaVersion", "organizationId", "postingId", "revision", "amount", "occurredAt", "status", "sourceRef", "scopes", "provenance"],
      {
        schemaVersion: { enum: [CONTRACT_SCHEMA_VERSION] }, organizationId: ORG_ID, postingId: ID, revision: REVISION,
        amount: POSITIVE_MONEY, occurredAt: TIMESTAMP, status: { enum: ["posted", "refunded"] }, obligationId: ID,
        commitmentRef: RECORD_REF, sourceRef: RECORD_REF, scopes: SCOPES, provenance: PROVENANCE,
        // Applied exposure deltas, kept out of the wire contract and projected out on every read.
        effect: {
          bsonType: "object", additionalProperties: false, required: ["recognizedMinor", "outstandingMinor"],
          properties: { recognizedMinor: SIGNED_INT, outstandingMinor: SIGNED_INT },
        },
      },
    ),
    indexes: [
      { key: { organizationId: 1, postingId: 1, revision: 1 }, name: "posting_identity", unique: true },
      { key: { organizationId: 1, "commitmentRef.id": 1 }, name: "posting_commitment" },
      { key: { organizationId: 1, occurredAt: 1 }, name: "posting_occurred" },
    ],
  },
  {
    name: CORRECTIONS_COLLECTION,
    validator: schema(
      ["schemaVersion", "organizationId", "correctionId", "originalPostingRef", "amount", "reason", "occurredAt", "provenance"],
      {
        schemaVersion: { enum: [CONTRACT_SCHEMA_VERSION] }, organizationId: ORG_ID, correctionId: ID,
        originalPostingRef: RECORD_REF, amount: SIGNED_NON_ZERO_MONEY, reason: NON_EMPTY_STRING,
        occurredAt: TIMESTAMP, provenance: PROVENANCE,
      },
    ),
    indexes: [
      { key: { organizationId: 1, correctionId: 1 }, name: "correction_identity", unique: true },
      { key: { organizationId: 1, "originalPostingRef.id": 1 }, name: "correction_posting" },
    ],
  },
  {
    name: AUDIT_EVENTS_COLLECTION,
    validator: schema(
      ["schemaVersion", "organizationId", "auditEventId", "type", "subjectRef", "actorId", "actorRoles", "occurredAt"],
      {
        schemaVersion: { enum: [CONTRACT_SCHEMA_VERSION] }, organizationId: ORG_ID, auditEventId: ID, type: NON_EMPTY_STRING,
        subjectRef: RECORD_REF, requestId: ID, actorId: ID, actorRoles: { bsonType: "array", items: NON_EMPTY_STRING },
        commandId: ID, correlationId: ID, occurredAt: TIMESTAMP, details: { bsonType: "object" },
      },
    ),
    indexes: [
      { key: { organizationId: 1, requestId: 1, occurredAt: 1 }, name: "audit_request" },
      { key: { organizationId: 1, occurredAt: 1 }, name: "audit_organization" },
    ],
  },
];

/** Creates or revalidates every financial collection and index. Idempotent. */
export async function ensureFinanceCollections(db: Db): Promise<void> {
  await ensureCollections(db, SPECS);
}
