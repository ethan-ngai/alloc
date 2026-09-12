import { describe, expect, it } from "vitest";
import {
  ActionReceiptSchema, ContractErrorSchema, DecideReviewInputSchema, EventEnvelopeSchema,
  ForecastAssumptionSchema, ForecastCommitmentProjectionSchema, ForecastSnapshotSchema,
  GetRequestToolInputSchema, MemoryResponseSchema, NonNegativeMoneySchema, PostingSchema,
  OrganizationIdSchema, PostingCorrectionSchema, ProposeActionToolInputSchema,
  PolicyRuleSchema,
  PurchaseRequestRevisionSchema, RequestAmendmentSchema, SignedMoneySchema,
  ToolExecutionContextSchema,
} from "../src/index.js";
import { contractExamples, northstarScenario, validateNorthstarScenario } from "../src/fixtures.js";

describe("strict structural contracts", () => {
  it("accepts only safe integer USD money with signed values limited to signed schemas", () => {
    expect(NonNegativeMoneySchema.parse({ amountMinor: 30, currency: "USD" })).toEqual({ amountMinor: 30, currency: "USD" });
    expect(NonNegativeMoneySchema.safeParse({ amountMinor: 30.5, currency: "USD" }).success).toBe(false);
    expect(NonNegativeMoneySchema.safeParse({ amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "USD" }).success).toBe(false);
    expect(NonNegativeMoneySchema.safeParse({ amountMinor: -1, currency: "USD" }).success).toBe(false);
    expect(NonNegativeMoneySchema.safeParse({ amountMinor: 30, currency: "EUR" }).success).toBe(false);
    expect(SignedMoneySchema.safeParse({ amountMinor: -30, currency: "USD" }).success).toBe(true);
    expect(PostingCorrectionSchema.shape.amount.safeParse({ amountMinor: 0, currency: "USD" }).success).toBe(false);
    expect(OrganizationIdSchema.safeParse("employee_maya_chen").success).toBe(false);
  });

  it("rejects invalid state, missing schema version, and missing provenance", () => {
    const request = structuredClone(northstarScenario.requestRevisions[0]!);
    expect(PurchaseRequestRevisionSchema.safeParse({ ...request, evaluationState: "dispatched" }).success).toBe(false);
    const { schemaVersion: _schemaVersion, ...withoutVersion } = request;
    expect(PurchaseRequestRevisionSchema.safeParse(withoutVersion).success).toBe(false);
    const { provenance: _provenance, ...withoutProvenance } = request;
    expect(PurchaseRequestRevisionSchema.safeParse(withoutProvenance).success).toBe(false);
  });

  it("keeps the 1.1.0 policy vocabulary optional and bounded", () => {
    const base = { ruleId: "rule_small_purchase", effect: "permit", categoryIds: ["category_travel"], requesterRoles: ["employee"], requireActivePurpose: true, requiredEvidenceKinds: ["document_excerpt"] };
    const extended = { ...base, eligibleVendorIds: ["vendor_buffalo_hotel"], maximumEvidenceAgeSeconds: 15_552_000, requiredApproverRole: "finance_manager", prohibitRequesterApproval: true, cumulativeLimitScope: "project" };
    expect(PolicyRuleSchema.parse(base)).toEqual(base);
    expect(PolicyRuleSchema.parse(extended)).toEqual(extended);
    expect(PolicyRuleSchema.safeParse({ ...extended, cumulativeLimitScope: "trip" }).success).toBe(false);
    expect(PolicyRuleSchema.safeParse({ ...extended, maximumEvidenceAgeSeconds: -1 }).success).toBe(false);
    expect(PolicyRuleSchema.safeParse({ ...extended, maximumEvidenceAgeSeconds: 1.5 }).success).toBe(false);
    expect(PolicyRuleSchema.safeParse({ ...extended, eligibleVendorIds: [] }).success).toBe(false);
    expect(PolicyRuleSchema.safeParse({ ...extended, requiredApproverRole: "" }).success).toBe(false);
    expect(PolicyRuleSchema.safeParse({ ...base, uninventedField: true }).success).toBe(false);
  });

  it("rejects authority, identity, priority, and lease injection in model arguments", () => {
    expect(GetRequestToolInputSchema.safeParse({ requestId: "request_buffalo_trip", organizationId: "org_attacker" }).success).toBe(false);
    expect(GetRequestToolInputSchema.safeParse({ requestId: "request_buffalo_trip", authorityGrantRefs: [] }).success).toBe(false);
    expect(GetRequestToolInputSchema.safeParse({ requestId: "request_buffalo_trip", priority: "P0", leaseGeneration: 99 }).success).toBe(false);
  });

  it("keeps backend tool context independently typed", () => {
    expect(ToolExecutionContextSchema.safeParse({
      schemaVersion: "1.0.0", organizationId: "org_northstar", principalId: "employee_maya_chen",
      serviceIdentityId: "service_agent_gateway", authorityGrantRefs: [], allowedScopes: [{ type: "project", id: "project_beacon" }],
      priority: "P0", jobId: "job_trip_investigation", leaseGeneration: 1, leaseExpiresAt: "2026-09-12T14:30:00Z",
    }).success).toBe(true);
  });

  it("requires action-specific model proposal fields", () => {
    const shared = { requestId: "request_buffalo_trip", requestRevision: 3, rationale: "Proceed", evidenceRefs: [] };
    expect(ProposeActionToolInputSchema.safeParse({ ...shared, type: "simulate_purchase" }).success).toBe(false);
    expect(ProposeActionToolInputSchema.safeParse({ ...shared, type: "simulate_purchase", amount: { amountMinor: 24_000, currency: "USD" } }).success).toBe(true);
    expect(ProposeActionToolInputSchema.safeParse({ ...shared, type: "cancel_request", amount: { amountMinor: 24_000, currency: "USD" } }).success).toBe(false);
    expect(ProposeActionToolInputSchema.safeParse({ ...shared, type: "cancel_request" }).success).toBe(true);
  });

  it("keeps authority grants out of caller-supplied review decisions", () => {
    const reviewInput = {
      meta: {
        schemaVersion: "1.0.0", organizationId: "org_northstar", commandId: "command_review_buffalo",
        correlationId: "correlation_buffalo_trip", expectedVersions: [],
      },
      payload: { requestId: "request_buffalo_trip", requestRevision: 3, outcome: "approved", rationale: "Approved" },
    };
    expect(DecideReviewInputSchema.safeParse(reviewInput).success).toBe(true);
    expect(DecideReviewInputSchema.safeParse({ ...reviewInput, payload: { ...reviewInput.payload, grant: northstarScenario.approvalGrant } }).success).toBe(false);
  });

  it("requires complete variant-specific forecast assumptions", () => {
    const shared = {
      assumptionId: "assumption_usage", name: "Adjust usage", scope: { type: "project", id: "project_beacon" },
      effectiveFrom: "2026-09-13T00:00:00Z", effectiveTo: "2026-09-30T23:59:59Z", evidenceRefs: [],
    };
    expect(ForecastAssumptionSchema.safeParse({ ...shared, kind: "fixed_adjustment" }).success).toBe(false);
    expect(ForecastAssumptionSchema.safeParse({ ...shared, kind: "fixed_adjustment", amount: { amountMinor: -3_000, currency: "USD" } }).success).toBe(true);
    expect(ForecastAssumptionSchema.safeParse({ ...shared, kind: "percentage_change", valueBasisPoints: -2_000, amount: { amountMinor: 1, currency: "USD" } }).success).toBe(false);
    expect(ForecastAssumptionSchema.safeParse({ ...shared, kind: "timing_shift", targetRef: { type: "schedule", id: "schedule_cloud", revision: 1 }, shiftDays: 7 }).success).toBe(true);
    expect(ForecastAssumptionSchema.safeParse({ ...shared, kind: "timing_shift", targetRef: { type: "schedule", id: "schedule_cloud" }, shiftDays: 7 }).success).toBe(false);
    expect(ForecastAssumptionSchema.safeParse({ ...shared, kind: "timing_shift", targetRef: { type: "schedule", id: "schedule_cloud", revision: 1 }, shiftDays: 0 }).success).toBe(false);
  });

  it("requires timing and scope in forecast commitment projections", () => {
    const commitment = northstarScenario.commitment;
    const projection = {
      organizationId: commitment.organizationId,
      commitmentRef: { type: "commitment", id: commitment.commitmentId, revision: commitment.revision },
      state: commitment.state,
      outstandingAmount: commitment.outstandingAmount,
      expectedAt: "2026-09-14T00:00:00Z",
      scopes: northstarScenario.requestRevisions[2]!.scopes,
    };
    expect(ForecastCommitmentProjectionSchema.parse(projection)).toMatchObject(projection);
    const { expectedAt: _expectedAt, ...withoutTiming } = projection;
    expect(ForecastCommitmentProjectionSchema.safeParse(withoutTiming).success).toBe(false);
  });

  it("validates stable failure response fixtures without claiming enforcement", () => {
    for (const error of Object.values(contractExamples.errors)) expect(ContractErrorSchema.parse(error).code).toBeTruthy();
  });
});

describe("frozen representative examples", () => {
  it("validates request, review, receipt, posting, memory, forecast, event, tool, and errors", () => {
    PurchaseRequestRevisionSchema.parse(northstarScenario.requestRevisions[2]);
    for (const amendment of northstarScenario.amendments) RequestAmendmentSchema.parse(amendment);
    ActionReceiptSchema.parse(northstarScenario.actionReceipt);
    PostingSchema.parse(northstarScenario.posting);
    expect(PostingSchema.parse({ ...northstarScenario.posting, obligationId: "contract_cloud" }).obligationId).toBe("contract_cloud");
    MemoryResponseSchema.parse(contractExamples.memory);
    ForecastSnapshotSchema.parse(contractExamples.forecast);
    const reduction = ForecastSnapshotSchema.parse(contractExamples.reductionForecast);
    expect(reduction.components.reduce((total, component) => total + component.amount.amountMinor, 0)).toBe(reduction.total.amountMinor);
    EventEnvelopeSchema.parse(contractExamples.event);
    GetRequestToolInputSchema.parse(contractExamples.toolInput);
    for (const error of Object.values(contractExamples.errors)) ContractErrorSchema.parse(error);
  });

  it("round-trips producer serialization through consumer validation", () => {
    const wire = JSON.stringify(contractExamples.event);
    const consumed = EventEnvelopeSchema.parse(JSON.parse(wire));
    expect(consumed.eventType).toBe("posting.recorded");
    if (consumed.eventType !== "posting.recorded") throw new Error("expected posting event");
    expect(consumed.payload.postingId).toBe("posting_buffalo_hotel");
  });
});

describe("Northstar contract-level integration/E2E trace", () => {
  it("traces $180 to $210 to reviewed $240 and reconciles spend exactly once", () => {
    validateNorthstarScenario(northstarScenario);
    const [initial, firstAmendment, secondAmendment] = northstarScenario.requestRevisions;
    expect(initial?.fullAmount.amountMinor).toBe(18_000);
    expect(firstAmendment?.fullAmount.amountMinor).toBe(21_000);
    expect(firstAmendment?.cumulativeIncrease.amountMinor).toBe(3_000);
    expect(secondAmendment?.fullAmount.amountMinor).toBe(24_000);
    expect(secondAmendment?.cumulativeIncrease.amountMinor).toBe(6_000);
    expect(secondAmendment?.evaluationState).toBe("review_required");
    expect(northstarScenario.approvedDecision.approvalGrantRef?.id).toBe(northstarScenario.approvalGrant.grantId);
    expect(northstarScenario.expectedTotals.outstandingCommitments.amountMinor).toBe(0);
    expect(northstarScenario.expectedTotals.recognizedSpend.amountMinor).toBe(24_000);
    expect(northstarScenario.expectedTotals.commitmentToSpend.amountMinor).toBe(24_000);
  });

  it("rejects mismatched fixture references", () => {
    const broken: any = structuredClone(northstarScenario);
    broken.posting.commitmentRef.id = "commitment_wrong";
    expect(() => validateNorthstarScenario(broken)).toThrow(/posting reconciliation/);
  });
});
