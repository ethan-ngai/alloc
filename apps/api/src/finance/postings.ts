import {
  CommitmentSchema, CONTRACT_SCHEMA_VERSION, PostingCorrectionSchema, PostingSchema,
  type Commitment, type Posting,
} from "@alloc/contracts";
import { usd } from "@alloc/financial-rules";
import type { ClientSession, Db } from "mongodb";
import { z } from "zod";
import { appendAuditEvents } from "./audit.js";
import { COMMITMENTS_COLLECTION, CORRECTIONS_COLLECTION, POSTINGS_COLLECTION } from "./collections.js";
import { resolveBindingBudgets, applyExposure, postingBudgetScopes, scopeKey } from "./budgets.js";
import { financeErrors } from "./errors.js";

export type PostingCorrection = z.infer<typeof PostingCorrectionSchema>;

/** Exposure deltas actually applied by one posting revision; internal to the ledger. */
const AppliedEffectSchema = z.strictObject({
  recognizedMinor: z.number().int(),
  outstandingMinor: z.number().int(),
});
type AppliedEffect = z.infer<typeof AppliedEffectSchema>;

const POSTING_PROJECTION = { _id: 0, effect: 0 } as const;

/**
 * The single canonical posting mutation. Source ingestion and the direct posting
 * command both call it, so an accepted imported expense updates the same
 * commitments, budgets, and audit trail as an authenticated posting.
 *
 * A matched posting moves the posted amount from outstanding commitment to
 * recognized spend without changing total exposure; the unmatched remainder
 * still increases recognized spend and may reveal overspend. A higher revision of
 * the same posting supersedes the applied revision: its exposure is reversed
 * before the new amount is applied, so an edited expense is netted, not doubled.
 */
export async function applyCanonicalPosting(
  db: Db,
  posting: Posting,
  session: ClientSession,
  observedAt: string,
): Promise<Posting> {
  const postings = db.collection(POSTINGS_COLLECTION);
  const identity = { organizationId: posting.organizationId, postingId: posting.postingId };

  const existing = await postings.findOne({ ...identity, revision: posting.revision }, { session, projection: POSTING_PROJECTION });
  if (existing) {
    return PostingSchema.parse(existing);
  }
  const newer = await postings.findOne(
    { ...identity, revision: { $gt: posting.revision } },
    { session, projection: POSTING_PROJECTION, sort: { revision: -1 } },
  );
  if (newer) {
    // A later source revision already owns this posting; the stale one has no effect.
    return PostingSchema.parse(newer);
  }
  const priorDocument = await postings.findOne(
    { ...identity, revision: { $lt: posting.revision } },
    { session, sort: { revision: -1 } },
  );
  const prior = priorDocument ? PostingSchema.parse(withoutInternalFields(priorDocument)) : null;
  const priorEffect = priorDocument ? readEffect(priorDocument) : null;

  const commitment = posting.commitmentRef
    ? await loadCommitment(db, posting.organizationId, posting.commitmentRef.id, posting.commitmentRef.revision, session)
    : null;
  const matched = commitment ? Math.min(posting.amount.amountMinor, commitment.outstandingAmount.amountMinor) : 0;
  const effect: AppliedEffect = { recognizedMinor: posting.amount.amountMinor, outstandingMinor: -matched };

  await postings.insertOne({ ...posting, schemaVersion: CONTRACT_SCHEMA_VERSION, effect }, { session });

  if (prior && priorEffect) {
    await reverseAppliedEffect(db, prior, priorEffect, session);
  }
  const accounts = await resolveBindingBudgets(db, posting.organizationId, postingBudgetScopes(posting), posting.occurredAt, session);
  await applyExposure(
    db,
    accounts,
    { recognized: effect.recognizedMinor, outstanding: effect.outstandingMinor },
    { enforceHardCap: false },
    session,
  );
  if (commitment && matched > 0) {
    await reduceCommitment(db, commitment, matched, session);
  }

  await appendAuditEvents(db, posting.organizationId, posting.postingId, [{
    type: "posting.recorded",
    subjectRef: { type: "posting", id: posting.postingId, revision: posting.revision },
    actorId: posting.provenance.sourceInstanceId,
    actorRoles: [],
    occurredAt: observedAt,
    details: {
      amountMinor: posting.amount.amountMinor,
      matchedMinor: matched,
      supersedesRevision: prior?.revision ?? null,
      scopes: posting.scopes.map(scopeKey),
    },
  }], session);
  return posting;
}

/** Compensating correction: releases or adds recognized exposure, never negative. */
export async function applyCanonicalCorrection(
  db: Db,
  correction: PostingCorrection,
  session: ClientSession,
  observedAt: string,
): Promise<PostingCorrection> {
  const corrections = db.collection(CORRECTIONS_COLLECTION);
  const existing = await corrections.findOne({ organizationId: correction.organizationId, correctionId: correction.correctionId }, { session, projection: { _id: 0 } });
  if (existing) {
    return PostingCorrectionSchema.parse(existing);
  }

  const posting = await loadPosting(db, correction.organizationId, correction.originalPostingRef.id, correction.originalPostingRef.revision, session);
  if (!posting) {
    throw financeErrors.notFound(`posting ${correction.originalPostingRef.id} does not exist in this organization`);
  }

  await corrections.insertOne({ ...correction, schemaVersion: CONTRACT_SCHEMA_VERSION }, { session });
  const accounts = await resolveBindingBudgets(db, correction.organizationId, postingBudgetScopes(posting), correction.occurredAt, session);
  await applyExposure(
    db,
    accounts,
    { recognized: correction.amount.amountMinor, outstanding: 0 },
    { enforceHardCap: false },
    session,
  );
  await appendAuditEvents(db, correction.organizationId, correction.correctionId, [{
    type: "posting.corrected",
    subjectRef: { type: "posting_correction", id: correction.correctionId },
    actorId: correction.provenance.sourceInstanceId,
    actorRoles: [],
    occurredAt: observedAt,
    details: { amountMinor: correction.amount.amountMinor, originalPostingId: correction.originalPostingRef.id },
  }], session);
  return correction;
}

function withoutInternalFields<T extends Record<string, unknown>>(document: T): Omit<T, "effect" | "_id"> {
  const { effect: _effect, _id: _id, ...rest } = document;
  return rest;
}

function readEffect(document: Record<string, unknown>): AppliedEffect | null {
  const parsed = AppliedEffectSchema.safeParse(document["effect"]);
  return parsed.success ? parsed.data : null;
}

async function reverseAppliedEffect(db: Db, prior: Posting, effect: AppliedEffect, session: ClientSession): Promise<void> {
  const accounts = await resolveBindingBudgets(db, prior.organizationId, postingBudgetScopes(prior), prior.occurredAt, session);
  await applyExposure(
    db,
    accounts,
    { recognized: -effect.recognizedMinor, outstanding: -effect.outstandingMinor },
    { enforceHardCap: false },
    session,
  );
  if (prior.commitmentRef && effect.outstandingMinor !== 0) {
    await restoreCommitment(db, prior.organizationId, prior.commitmentRef.id, -effect.outstandingMinor, session);
  }
}

async function loadCommitment(
  db: Db,
  organizationId: string,
  commitmentId: string,
  revision: number | undefined,
  session: ClientSession,
): Promise<Commitment | null> {
  const document = await db
    .collection(COMMITMENTS_COLLECTION)
    .findOne({ organizationId, commitmentId }, { session, projection: { _id: 0 } });
  if (!document) {
    return null;
  }
  const commitment = CommitmentSchema.parse(document);
  if (revision !== undefined && revision !== commitment.revision) {
    return null;
  }
  return commitment;
}

async function loadPosting(db: Db, organizationId: string, postingId: string, revision: number | undefined, session: ClientSession): Promise<Posting | null> {
  const filter = revision === undefined
    ? { organizationId, postingId }
    : { organizationId, postingId, revision };
  const document = await db
    .collection(POSTINGS_COLLECTION)
    .findOne(filter, { session, projection: POSTING_PROJECTION, sort: { revision: -1 } });
  return document === null ? null : PostingSchema.parse(document);
}

async function reduceCommitment(db: Db, commitment: Commitment, matched: number, session: ClientSession): Promise<void> {
  await writeCommitmentOutstanding(db, commitment, commitment.outstandingAmount.amountMinor - matched, session);
}

async function restoreCommitment(db: Db, organizationId: string, commitmentId: string, deltaMinor: number, session: ClientSession): Promise<void> {
  const document = await db.collection(COMMITMENTS_COLLECTION).findOne({ organizationId, commitmentId }, { session, projection: { _id: 0 } });
  if (!document) {
    return;
  }
  const commitment = CommitmentSchema.parse(document);
  await writeCommitmentOutstanding(db, commitment, commitment.outstandingAmount.amountMinor + deltaMinor, session);
}

async function writeCommitmentOutstanding(db: Db, commitment: Commitment, outstandingMinor: number, session: ClientSession): Promise<void> {
  const outstanding = usd(outstandingMinor);
  if (outstanding.amountMinor < 0 || outstanding.amountMinor > commitment.amount.amountMinor) {
    throw financeErrors.staleVersion(`commitment ${commitment.commitmentId} outstanding would leave 0..${commitment.amount.amountMinor}`);
  }
  const state = outstanding.amountMinor === 0
    ? "posted"
    : outstanding.amountMinor < commitment.amount.amountMinor
      ? "partially_posted"
      : "outstanding";
  const result = await db.collection(COMMITMENTS_COLLECTION).updateOne(
    { organizationId: commitment.organizationId, commitmentId: commitment.commitmentId, revision: commitment.revision },
    { $set: { outstandingAmount: outstanding, state, revision: commitment.revision + 1 } },
    { session },
  );
  if (result.matchedCount !== 1) {
    throw financeErrors.staleVersion(`commitment ${commitment.commitmentId} changed during the transaction`);
  }
}
