import { IdSchema, OrganizationIdSchema } from "@alloc/contracts";
import { z } from "zod";

/** Roles are stable lowercase identifiers; they grant nothing on their own. */
export const RoleSchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);

/** Claims required from a verified token; every field is mandatory. */
export const JwtClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  exp: z.number().int().positive(),
  sub: IdSchema,
  org: OrganizationIdSchema,
  roles: z.array(RoleSchema).min(1),
});

export type JwtClaims = z.infer<typeof JwtClaimsSchema>;

/** Tenant identity derived only from verified claims. */
export interface Principal {
  readonly principalId: string;
  readonly organizationId: string;
  readonly roles: readonly string[];
}

export function principalFromClaims(claims: JwtClaims): Principal {
  return Object.freeze({
    principalId: claims.sub,
    organizationId: claims.org,
    roles: Object.freeze([...new Set(claims.roles)]),
  });
}
