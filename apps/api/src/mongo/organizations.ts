import { CompanyEntitySchema, type CompanyEntity } from "@alloc/contracts";
import type { Db } from "mongodb";

export const ORGANIZATIONS_COLLECTION = "organizations";
export const ORGANIZATION_ID_INDEX = "organizations_by_organization_id";

/** Read access to organization entities, always scoped to one organization ID. */
export interface OrganizationRepository {
  findById(organizationId: string): Promise<CompanyEntity | null>;
}

const ID_PATTERN = "^[a-z][a-z0-9]*(_[a-z0-9]+)+$";
const ORGANIZATION_ID_PATTERN = "^org_[a-z0-9]+(_[a-z0-9]+)*$";
const TIMESTAMP_PATTERN =
  "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]+)?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$";

const SCOPE_TYPES = [
  "organization",
  "department",
  "project",
  "category",
  "location",
  "vendor",
  "employee",
  "customer",
  "asset",
  "contract",
  "legal_entity",
  "account",
];

const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"];

/**
 * MongoDB's own `$jsonSchema` dialect mirrors `CompanyEntitySchema` for
 * organization entities. It is intentionally strict about unknown fields so a
 * document that would fail contract validation cannot be stored either.
 */
export const ORGANIZATION_VALIDATOR = {
  $and: [
    {
      $jsonSchema: {
        additionalProperties: false,
        bsonType: "object",
        required: [
          "_id",
          "schemaVersion",
          "organizationId",
          "entityId",
          "revision",
          "kind",
          "displayName",
          "access",
          "provenance",
          "attributes",
        ],
        properties: {
          _id: { bsonType: "objectId" },
          schemaVersion: { enum: ["1.0.0"] },
          organizationId: { bsonType: "string", pattern: ORGANIZATION_ID_PATTERN },
          entityId: { bsonType: "string", pattern: ID_PATTERN },
          revision: {
            bsonType: ["int", "long", "double"],
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
            multipleOf: 1,
          },
          kind: { enum: ["organization"] },
          displayName: { bsonType: "string", minLength: 1 },
          projectId: { bsonType: "string", pattern: ID_PATTERN },
          access: {
            bsonType: "object",
            additionalProperties: false,
            required: ["classification", "scopeRefs"],
            properties: {
              classification: { enum: CLASSIFICATIONS },
              scopeRefs: {
                bsonType: "array",
                minItems: 1,
                items: {
                  bsonType: "object",
                  additionalProperties: false,
                  required: ["type", "id"],
                  properties: {
                    type: { enum: SCOPE_TYPES },
                    id: { bsonType: "string", pattern: ID_PATTERN },
                  },
                },
              },
              allowedPrincipalIds: {
                bsonType: "array",
                items: { bsonType: "string", pattern: ID_PATTERN },
              },
            },
          },
          provenance: {
            bsonType: "object",
            additionalProperties: false,
            required: [
              "kind",
              "trust",
              "sourceInstanceId",
              "sourceObjectId",
              "sourceRevision",
              "occurredAt",
              "observedAt",
            ],
            properties: {
              kind: { enum: ["synthetic", "imported", "live"] },
              trust: { enum: ["authoritative", "evidence", "candidate"] },
              sourceInstanceId: { bsonType: "string", pattern: ID_PATTERN },
              sourceObjectId: { bsonType: "string", minLength: 1 },
              sourceRevision: { bsonType: "string", minLength: 1 },
              occurredAt: { bsonType: "string", pattern: TIMESTAMP_PATTERN },
              observedAt: { bsonType: "string", pattern: TIMESTAMP_PATTERN },
            },
          },
          attributes: {
            bsonType: "object",
            additionalProperties: {
              anyOf: [
                { bsonType: "string" },
                { bsonType: "int" },
                { bsonType: "long", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
                { bsonType: "double", minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE },
                { bsonType: "bool" },
                { bsonType: "null" },
              ],
            },
          },
        },
      },
    },
    {
      $expr: {
        $and: [
          {
            $ne: [
              { $dateFromString: { dateString: "$provenance.occurredAt", onError: null, onNull: null } },
              null,
            ],
          },
          {
            $ne: [
              { $dateFromString: { dateString: "$provenance.observedAt", onError: null, onNull: null } },
              null,
            ],
          },
        ],
      },
    },
  ],
} as const;

/**
 * Creates or revalidates the organization collection and its indexes. Safe to
 * run on every startup: the validator is updated in place and index creation is
 * idempotent.
 */
export async function ensureOrganizationCollection(db: Db): Promise<void> {
  const options = {
    validator: ORGANIZATION_VALIDATOR,
    validationLevel: "strict",
    validationAction: "error",
  } as const;

  const exists = await db.listCollections({ name: ORGANIZATIONS_COLLECTION }, { nameOnly: true }).hasNext();
  if (exists) {
    await db.command({ collMod: ORGANIZATIONS_COLLECTION, ...options });
  } else {
    try {
      await db.createCollection(ORGANIZATIONS_COLLECTION, options);
    } catch (error) {
      // Another process created it between the check and the write.
      if ((error as { codeName?: unknown } | null)?.codeName !== "NamespaceExists") {
        throw error;
      }
      await db.command({ collMod: ORGANIZATIONS_COLLECTION, ...options });
    }
  }

  await db.collection(ORGANIZATIONS_COLLECTION).createIndexes([
    { key: { organizationId: 1 }, name: ORGANIZATION_ID_INDEX, unique: true },
  ]);
}

export class MongoOrganizationRepository implements OrganizationRepository {
  constructor(private readonly db: Db) {}

  async findById(organizationId: string): Promise<CompanyEntity | null> {
    const document = await this.db
      .collection(ORGANIZATIONS_COLLECTION)
      .findOne({ organizationId }, { projection: { _id: 0 } });
    // A stored document that violates the shared contract is an internal fault,
    // not a client error: surface it as a failure rather than a partial entity.
    return document === null ? null : CompanyEntitySchema.parse(document);
  }
}
