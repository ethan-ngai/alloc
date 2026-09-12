import assert from "node:assert/strict";
import * as contracts from "@alloc/contracts";

export function validateCompany(fixture) {
  const { manifest, scenario } = fixture;
  contracts.OrganizationIdSchema.parse(manifest.organizationId);
  contracts.TimestampSchema.parse(manifest.referenceDate);
  contracts.TimestampSchema.parse(manifest.historyStart);
  contracts.IdSchema.parse(scenario.scenarioId);
  assert.equal(manifest.schemaVersion, "1.0.0");
  assert.equal(manifest.fixtureVersion, "1.0.0");
  assert.equal(manifest.label, "synthetic");
  assert.equal(manifest.seed, scenario.seed);
  assert.equal(scenario.organizationId, manifest.organizationId);
  assert.equal(fixture.runtimeSchedule.length, fixture.runtimeDeliveries.length);
  fixture.runtimeSchedule.forEach(at => contracts.TimestampSchema.parse(at));
  const registry = new Map();
  const records = [];
  const add = (type, schema, value, field, revision = value.revision ?? 1) => {
    const record = schema.parse(value);
    assert.equal(record.organizationId, manifest.organizationId, "cross-company record");
    const recordKey = `${type}:${record[field]}:${revision}`;
    assert(!registry.has(recordKey), `duplicate record ${recordKey}`);
    registry.set(recordKey, record);
    records.push(record);
    return record;
  };
  for (const [collection, type, schemaName, field] of [
    ["entities", "entity", "CompanyEntitySchema", "entityId"],
    ["policies", "policy", "PolicySchema", "policyId"],
    ["budgets", "budget_account", "BudgetAccountSchema", "budgetAccountId"],
    ["evidence", "evidence", "EvidenceSchema", "evidenceId"],
    ["relationships", "relationship", "RelationshipSchema", "relationshipId"],
    ["schedules", "schedule", "FinancialScheduleSchema", "scheduleId"],
    ["postings", "posting", "PostingSchema", "postingId"],
  ]) for (const value of fixture[collection]) add(type, contracts[schemaName], value, field);
  for (const value of scenario.requestRevisions) add("request", contracts.PurchaseRequestRevisionSchema, value, "requestId");
  for (const value of scenario.amendments) add("amendment", contracts.RequestAmendmentSchema, value, "amendmentId");
  for (const value of [...scenario.initialDecisions, scenario.reviewDecision, scenario.approvedDecision]) add("decision", contracts.DecisionSchema, value, "decisionId");
  for (const value of [...scenario.commitmentSnapshots, scenario.commitment]) add("commitment", contracts.CommitmentSchema, value, "commitmentId");
  for (const [field, type, schemaName, idField] of [
    ["approvalGrant", "approval_grant", "ApprovalGrantSchema", "grantId"],
    ["actionIntent", "action_intent", "ActionIntentSchema", "actionIntentId"],
    ["actionReceipt", "action_receipt", "ActionReceiptSchema", "receiptId"],
    ["posting", "posting", "PostingSchema", "postingId"],
  ]) add(type, contracts[schemaName], scenario[field], idField);
  const entities = new Map(fixture.entities.map(record => [record.entityId, record]));
  assert(entities.has(manifest.organizationId), "missing organization entity");
  const sources = new Set();
  for (const source of manifest.sourceInstances) {
    contracts.IdSchema.parse(source.sourceInstanceId);
    assert.equal(source.organizationId, manifest.organizationId);
    assert.equal(source.kind, "synthetic");
    assert.equal(source.authority, "fixture_only");
    assert(!sources.has(source.sourceInstanceId), "duplicate source identity");
    sources.add(source.sourceInstanceId);
  }
  const entityRef = (entityId, kind) => {
    const target = entities.get(entityId);
    assert(target, `missing entity ${entityId}`);
    if (kind) assert.equal(target.kind, kind === "account" ? "financial_account" : kind, `wrong entity kind ${entityId}`);
    return target;
  };
  const resolve = reference => {
    if (reference.type === "source_record") return resolve({ ...reference, type: "evidence" });
    if (reference.type === "contract") {
      const target = entityRef(reference.id, "contract");
      assert.equal(reference.revision ?? 1, target.revision, "stale entity revision");
      return target;
    }
    const target = registry.get(`${reference.type}:${reference.id}:${reference.revision ?? 1}`);
    assert(target, `missing record reference ${JSON.stringify(reference)}`);
    return target;
  };
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (value.type && value.id) {
      if (contracts.ScopeRefSchema.safeParse(value).success) entityRef(value.id, value.type);
      else resolve(value);
    }
    if (value.sourceInstanceId) assert(sources.has(value.sourceInstanceId), "unknown source identity");
    if (value.kind === "synthetic") {
      assert(Date.parse(value.observedAt) >= Date.parse(value.occurredAt), "source observed before occurrence");
    }
    for (const [field, item] of Object.entries(value)) {
      const kind = { categoryId: "category", vendorId: "vendor", projectId: "project", requesterId: "employee", approverId: "employee", publishedBy: "employee", submittedBy: "employee" }[field];
      if (kind) entityRef(item, kind);
      if (["fromId", "toId", "obligationId"].includes(field)) entityRef(item);
      if (field === "categoryIds") item.forEach(entityId => entityRef(entityId, "category"));
      if (["allowedPrincipalIds", "entityIds"].includes(field)) item.forEach(entityId => entityRef(entityId));
      visit(item);
    }
  };
  for (const record of records) {
    if (record.provenance) assert.equal(record.provenance.kind, "synthetic", "non-synthetic fixture provenance");
    visit(record);
  }
  for (const mapping of manifest.mappings) {
    assert(sources.has(mapping.sourceInstanceId));
    entityRef(mapping.entityId);
  }
  for (const fact of fixture.facts) {
    contracts.MemoryFactSchema.parse(fact);
    assert.equal(fact.provenance.kind, "synthetic");
    visit(fact);
  }
  for (const delivery of [...fixture.deliveries, ...fixture.runtimeDeliveries]) {
    contracts.SourceDeliverySchema.parse(delivery);
    assert.equal(delivery.organizationId, manifest.organizationId, "cross-company delivery");
    assert.equal(delivery.isSynthetic, true);
    assert.equal(delivery.provenance.kind, "synthetic");
    for (const field of ["sourceInstanceId", "sourceObjectId", "sourceRevision", "occurredAt", "observedAt"]) assert.equal(delivery[field], delivery.provenance[field], `delivery/provenance ${field} mismatch`);
    visit(delivery);
    if (delivery.eventType === "fixture.expense") {
      const posting = contracts.PostingSchema.parse(delivery.payload.posting);
      assert.deepEqual(posting, resolve({ type: "posting", id: posting.postingId, revision: posting.revision }), "source payload differs from canonical posting");
    } else assert.equal(delivery.provenance.trust, "evidence", "operational text cannot authorize finance");
  }
  const expenseDeliveries = fixture.deliveries.filter(delivery => delivery.eventType === "fixture.expense");
  assert.equal(expenseDeliveries.length, fixture.postings.length, "missing expense delivery");
  assert.equal(new Set(expenseDeliveries.map(delivery => delivery.payload.posting.postingId)).size, fixture.postings.length, "duplicate expense delivery");
  const safeSum = values => {
    const result = values.reduce((sum, value) => sum + BigInt(value), 0n);
    assert(result <= BigInt(Number.MAX_SAFE_INTEGER) && result >= 0n, "unsafe total");
    return Number(result);
  };
  assert.equal(fixture.postings.length, fixture.expectations.expenseCount);
  const baseline = safeSum(fixture.postings.map(record => record.amount.amountMinor));
  assert.equal(baseline, fixture.expectations.baselineSpendMinor, "baseline spend mismatch");
  assert.equal(baseline + scenario.posting.amount.amountMinor, fixture.expectations.finalSpendMinor, "final spend mismatch");
  const requests = scenario.requestRevisions;
  assert.equal(requests.length, 3);
  requests.forEach((request, index) => {
    assert.equal(request.revision, index + 1);
    assert.equal(request.previousRevision, index || null);
    assert.equal(request.increaseFromPrevious.amountMinor, index ? request.fullAmount.amountMinor - requests[index - 1].fullAmount.amountMinor : 0);
    assert.equal(request.cumulativeIncrease.amountMinor, request.fullAmount.amountMinor - requests[0].fullAmount.amountMinor);
  });
  scenario.amendments.forEach((amendment, index) => {
    assert.equal(amendment.requestId, requests[index].requestId);
    assert.equal(amendment.fromRevision, index + 1);
    assert.equal(amendment.toRevision, index + 2);
    assert.deepEqual(amendment.previousFullAmount, requests[index].fullAmount);
    assert.deepEqual(amendment.revisedFullAmount, requests[index + 1].fullAmount);
    assert.deepEqual(amendment.increase, requests[index + 1].increaseFromPrevious);
    assert.deepEqual(amendment.cumulativeIncrease, requests[index + 1].cumulativeIncrease);
  });
  for (const decision of [...scenario.initialDecisions, scenario.reviewDecision, scenario.approvedDecision]) {
    const request = resolve(decision.requestRef);
    assert.deepEqual(decision.evaluatedFullAmount, request.fullAmount);
    assert.deepEqual(decision.evaluatedCumulativeIncrease, request.cumulativeIncrease);
    if (decision.permittedAction) assert.deepEqual(decision.permittedAction.amount, request.fullAmount);
  }
  assert.deepEqual(scenario.approvalGrant.exactAmount, requests[2].fullAmount);
  assert.deepEqual(scenario.approvalGrant.requestRef, scenario.approvedDecision.requestRef);
  assert.equal(scenario.approvedDecision.approvalGrantRef.id, scenario.approvalGrant.grantId);
  assert.equal(scenario.reviewDecision.outcome, "review_required");
  assert.equal(scenario.reviewDecision.permittedAction, null);
  assert.deepEqual(scenario.actionIntent.action.amount, requests[2].fullAmount);
  assert.deepEqual(scenario.actionReceipt.amount, scenario.actionIntent.action.amount);
  assert.equal(scenario.actionReceipt.providerInstanceId, scenario.actionIntent.providerInstanceId);
  for (const commitment of [...scenario.commitmentSnapshots, scenario.commitment]) {
    assert.deepEqual(commitment.amount, resolve(commitment.requestRef).fullAmount);
    const decision = resolve(commitment.decisionRef);
    assert.equal(decision.outcome, "approved");
    assert.deepEqual(decision.requestRef, commitment.requestRef);
    assert.equal(commitment.outstandingAmount.amountMinor + (commitment.state === "posted" ? scenario.posting.amount.amountMinor : 0), commitment.amount.amountMinor, "commitment reconciliation mismatch");
  }
  for (const budget of fixture.budgets) {
    const finalPostings = [...fixture.postings, scenario.posting].filter(posting => posting.scopes.some(scope => scope.type === budget.scope.type && scope.id === budget.scope.id));
    assert.equal(budget.recognizedSpend.amountMinor, safeSum(finalPostings.map(posting => posting.amount.amountMinor)), "budget spend mismatch");
    assert.equal(budget.outstandingCommitments.amountMinor, scenario.commitment.outstandingAmount.amountMinor);
    assert.equal(budget.available.amountMinor, budget.authorized.amountMinor - budget.recognizedSpend.amountMinor - budget.outstandingCommitments.amountMinor);
  }
  return fixture;
}
