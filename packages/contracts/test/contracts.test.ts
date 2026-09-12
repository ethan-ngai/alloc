import { describe, expect, it } from "vitest";
import {
  ActionReceiptSchema, ContractErrorSchema, EventEnvelopeSchema, ForecastSnapshotSchema,
  GetRequestToolInputSchema, MemoryResponseSchema, NonNegativeMoneySchema, PostingSchema,
  OrganizationIdSchema, PostingCorrectionSchema, PurchaseRequestRevisionSchema, RequestAmendmentSchema, SignedMoneySchema, SourceDeliverySchema,
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
    MemoryResponseSchema.parse(contractExamples.memory);
    ForecastSnapshotSchema.parse(contractExamples.forecast);
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
