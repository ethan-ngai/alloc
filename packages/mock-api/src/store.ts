import { CONTRACT_SCHEMA_VERSION } from "@alloc/contracts";
import type { Commitment, Decision, OperationInput, OperationName, OperationResult, Posting, PurchaseRequestRevision, RequestAmendment } from "@alloc/contracts";
import type { ActivityItem, BudgetAccount, ForecastSnapshot, PostingCorrection, RecordRef, ScopeRef, SourceDelivery } from "./contract-types.js";
import type { Clock } from "./clock.js";
import { DEFAULT_MOCK_CLOCK, createClock } from "./clock.js";
import { MockContractError } from "./errors.js";
import { createIdFactory } from "./ids.js";
import type { IdFactory } from "./ids.js";
import { createPackRegistry } from "./packs.js";
import type { CompanyPack, PackRegistry } from "./packs.js";
import { createCompanyPacks } from "./packs.js";
import { HANDLERS } from "./handlers/index.js";
import type { AnyHandler, HandlerContext } from "./handlers/context.js";
import { decisionSummary, postingSummary } from "./handlers/context.js";

export interface Principal {
  principalId: string;
  organizationId: string;
  authorityRole: string | null;
  scopeRefs: ScopeRef[];
}

/**
 * The contract `ActivityItem` carries no scopes, so scope filtering is a server-side concern and is
 * kept beside the item rather than widening the contract.
 */
export interface ActivityRecord {
  item: ActivityItem;
  scopeRefs: ScopeRef[];
}

export interface IngestRecord {
  deliveryRef: RecordRef;
  normalizedRefs: RecordRef[];
}

export interface IdempotencyRecord {
  payloadJson: string;
  data: unknown;
}

export interface CompanyState {
  organizationId: string;
  pack: CompanyPack;
  registry: PackRegistry;
  seededAt: string;
  requests: Map<string, PurchaseRequestRevision[]>;
  amendments: RequestAmendment[];
  decisions: Decision[];
  commitments: Map<string, Commitment>;
  postings: Posting[];
  corrections: PostingCorrection[];
  budgetAccounts: Map<string, BudgetAccount>;
  deliveries: SourceDelivery[];
  ingestLedger: Map<string, IngestRecord>;
  idempotency: Map<string, IdempotencyRecord>;
  activity: ActivityRecord[];
  forecasts: Map<string, ForecastSnapshot[]>;
}

export interface MockHealth {
  status: "ok";
  schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  clock: string;
  organizations: string[];
  scenarioIds: Record<string, string>;
  provisional: true;
}

export type OperationData<Name extends OperationName> = Extract<OperationResult<Name>, { ok: true }>["data"];

export interface MockStore {
  readonly clock: Clock;
  readonly packs: readonly CompanyPack[];
  readonly organizations: string[];
  reset(organizationId?: string): void;
  health(): MockHealth;
  principalFor(organizationId: string, principalId?: string): Principal;
  execute<Name extends OperationName>(operation: Name, input: OperationInput<Name>, principal: Principal): OperationData<Name>;
  state(organizationId: string): CompanyState;
  appendActivity(organizationId: string, item: ActivityItem, scopeRefs: ScopeRef[]): void;
}

export interface MockStoreOptions {
  clock?: string;
  packs?: CompanyPack[];
}

function seedCompanyState(pack: CompanyPack): CompanyState {
  const request = structuredClone(pack.request);
  const decision = structuredClone(pack.decision);
  const commitment = structuredClone(pack.commitment);
  const posting = structuredClone(pack.posting);
  const budgetAccount = structuredClone(pack.budgetAccount);
  const forecast = structuredClone(pack.forecast);
  return {
    organizationId: pack.identity.organizationId,
    pack,
    registry: createPackRegistry(pack),
    seededAt: pack.seededAt,
    requests: new Map([[request.requestId, [request]]]),
    amendments: [],
    decisions: [decision],
    commitments: new Map([[commitment.commitmentId, commitment]]),
    postings: [posting],
    corrections: [],
    budgetAccounts: new Map([[budgetAccount.budgetAccountId, budgetAccount]]),
    deliveries: [],
    ingestLedger: new Map(),
    idempotency: new Map(),
    activity: [
      {
        item: {
          activityId: "activity_seed_approval",
          type: "decision",
          occurredAt: decision.decidedAt,
          subjectRef: { type: "decision", id: decision.decisionId, revision: 1 },
          summary: decisionSummary(decision, request.requestId, request.revision),
        },
        scopeRefs: structuredClone(request.scopes),
      },
      {
        item: {
          activityId: "activity_seed_posting",
          type: "posting",
          occurredAt: posting.occurredAt,
          subjectRef: { type: "posting", id: posting.postingId, revision: posting.revision },
          summary: postingSummary(posting),
        },
        scopeRefs: structuredClone(posting.scopes),
      },
    ],
    forecasts: new Map([[forecast.forecastId, [forecast]]]),
  };
}

/**
 * The mock store. Mutations are synchronous and single-threaded, so every command applies
 * atomically by construction; atomicity across caps, commitments, decisions, and action intents is
 * a real-backend (3B) obligation, not something this in-memory store proves.
 */
export function createMockStore(options: MockStoreOptions = {}): MockStore {
  const clockStart = options.clock ?? DEFAULT_MOCK_CLOCK;
  const clock = createClock(clockStart);
  const packs = options.packs ?? createCompanyPacks(clockStart);
  const states = new Map<string, CompanyState>(packs.map((pack) => [pack.identity.organizationId, seedCompanyState(pack)]));
  const ids: IdFactory = createIdFactory();

  const requireState = (organizationId: string): CompanyState => {
    const company = states.get(organizationId);
    if (!company) {
      throw new MockContractError("ACCESS_DENIED", `organization ${organizationId} is not registered with the mock`);
    }
    return company;
  };

  const store: MockStore = {
    clock,
    packs,
    organizations: [...states.keys()],
    reset(organizationId) {
      if (organizationId !== undefined) {
        if (!states.has(organizationId)) {
          throw new MockContractError("NOT_FOUND", `organization ${organizationId} is not registered with the mock`);
        }
        const pack = packs.find((candidate) => candidate.identity.organizationId === organizationId);
        if (!pack) throw new MockContractError("NOT_FOUND", `no pack for organization ${organizationId}`);
        states.set(organizationId, seedCompanyState(pack));
        return;
      }
      for (const pack of packs) states.set(pack.identity.organizationId, seedCompanyState(pack));
    },
    health() {
      const scenarioIds: Record<string, string> = {};
      for (const pack of packs) scenarioIds[pack.identity.organizationId] = pack.identity.scenarioId;
      return {
        status: "ok",
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        clock: clock.now(),
        organizations: [...states.keys()],
        scenarioIds,
        provisional: true,
      };
    },
    principalFor(organizationId, principalId) {
      const company = requireState(organizationId);
      const principal = principalId === undefined
        ? company.pack.principals.find((candidate) => candidate.principalId === company.pack.defaultPrincipalId)
        : company.pack.principals.find((candidate) => candidate.principalId === principalId);
      if (!principal) {
        const requested = principalId ?? company.pack.defaultPrincipalId;
        throw new MockContractError("ACCESS_DENIED", `principal ${requested} is not registered for ${organizationId}`);
      }
      return {
        principalId: principal.principalId,
        organizationId,
        authorityRole: principal.authorityRole,
        scopeRefs: structuredClone(principal.scopeRefs),
      };
    },
    execute(operation, input, principal) {
      const company = requireState(input.meta.organizationId);
      if (principal.organizationId !== company.organizationId) {
        throw new MockContractError("ACCESS_DENIED", `principal ${principal.principalId} does not belong to ${company.organizationId}`);
      }
      const meta = "commandId" in input.meta
        ? { correlationId: input.meta.correlationId, commandId: input.meta.commandId, expectedVersions: input.meta.expectedVersions }
        : { correlationId: input.meta.correlationId };
      const ctx: HandlerContext = { company, principal, clock, ids, store, meta };
      const handler = HANDLERS[operation] as unknown as AnyHandler;
      const payload: unknown = (input as { payload: unknown }).payload;
      return handler(ctx, payload as never) as OperationData<typeof operation>;
    },
    state(organizationId) {
      return requireState(organizationId);
    },
    appendActivity(organizationId, item, scopeRefs) {
      requireState(organizationId).activity.push({ item, scopeRefs: structuredClone(scopeRefs) });
    },
  };
  return store;
}
