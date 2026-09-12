import { CompanyEntitySchema, type CompanyEntity } from "@alloc/contracts";

/** Organization of the 1A Northstar fixture company, validated by the shared contract. */
export const NORTHSTAR_ORGANIZATION_ID = "org_northstar";

export const northstarOrganization: CompanyEntity = CompanyEntitySchema.parse({
  schemaVersion: "1.0.0",
  organizationId: NORTHSTAR_ORGANIZATION_ID,
  entityId: "organization_northstar_fieldworks",
  revision: 1,
  kind: "organization",
  displayName: "Northstar Fieldworks",
  access: {
    classification: "internal",
    scopeRefs: [{ type: "organization", id: NORTHSTAR_ORGANIZATION_ID }],
    allowedPrincipalIds: [],
  },
  provenance: {
    kind: "synthetic",
    trust: "authoritative",
    sourceInstanceId: "source_northstar_simulator",
    sourceObjectId: "northstar-organization",
    sourceRevision: "1",
    occurredAt: "2026-09-12T14:00:00Z",
    observedAt: "2026-09-12T14:00:00Z",
  },
  attributes: { industry: "industrial software", currency: "USD" },
});

/** Second tenant used to prove cross-organization isolation. */
export const juniperOrganizationId = "org_juniper";

export const juniperOrganization: CompanyEntity = CompanyEntitySchema.parse({
  ...northstarOrganization,
  organizationId: juniperOrganizationId,
  entityId: "organization_juniper_table",
  displayName: "Juniper Table",
  access: { classification: "internal", scopeRefs: [{ type: "organization", id: juniperOrganizationId }], allowedPrincipalIds: [] },
  provenance: { ...northstarOrganization.provenance, sourceObjectId: "juniper-organization" },
  attributes: { industry: "restaurants", currency: "USD" },
});
