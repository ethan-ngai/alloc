#!/usr/bin/env node

import { loadCompany } from "@alloc/company-fixtures";
import { connectMongoRuntime } from "../apps/api/dist/mongo/runtime.js";
import { ORGANIZATIONS_COLLECTION } from "../apps/api/dist/mongo/organizations.js";

const COMPANY_KEYS = ["northstar", "juniper", "forge"];

export async function seedDevelopmentData({ mongoUri, database }) {
  const runtime = await connectMongoRuntime({ uri: mongoUri, database });
  try {
    for (const key of COMPANY_KEYS) {
      const fixture = loadCompany(key);
      const organization = fixture.entities.find((entity) => entity.kind === "organization");
      if (!organization) throw new Error(`${key} fixture has no organization entity`);

      await runtime.db.collection(ORGANIZATIONS_COLLECTION).replaceOne(
        { organizationId: organization.organizationId },
        organization,
        { upsert: true },
      );
      await runtime.imports.seedEntities(fixture.entities);
      await runtime.imports.seedMappings(fixture.manifest.mappings);
      await runtime.graph.seedEvidence(fixture.evidence);
      await runtime.graph.seedRelationships(fixture.relationships);

      const request = fixture.scenario.requestRevisions[0];
      const purposeEvidence = fixture.evidence.find((evidence) => evidence.kind === "document_excerpt") ?? fixture.evidence[0];
      const allowedScopes = [...new Map(
        fixture.entities.flatMap((entity) => entity.access.scopeRefs).map((scope) => [`${scope.type}:${scope.id}`, scope]),
      ).values()];
      await runtime.finance.seed(organization.organizationId, {
        policies: fixture.policies,
        budgets: fixture.budgets.map((budget) => ({
          ...budget,
          revision: 1,
          recognizedSpend: { amountMinor: 0, currency: budget.authorized.currency },
          outstandingCommitments: { amountMinor: 0, currency: budget.authorized.currency },
          available: { ...budget.authorized },
        })),
        evidence: fixture.evidence,
        purposes: purposeEvidence && request ? [{
          purpose: request.purpose,
          active: true,
          ref: { type: "evidence", id: purposeEvidence.evidenceId, revision: purposeEvidence.revision },
        }] : [],
        authorities: [{ principalId: "principal_dev", roles: ["approver", "finance_manager"], scopes: allowedScopes }],
      });
    }
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const mongoUri = process.env.MONGO_URI;
  const database = process.env.MONGO_DATABASE;
  if (!mongoUri || !database) throw new Error("MONGO_URI and MONGO_DATABASE are required");
  await seedDevelopmentData({ mongoUri, database });
  console.log(`[dev] seeded ${COMPANY_KEYS.length} synthetic company profiles in ${database}`);
}
