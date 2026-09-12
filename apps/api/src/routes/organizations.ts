import { CompanyEntitySchema, operationResult, OrganizationIdSchema } from "@alloc/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../auth/plugin.js";
import { correlationIdOf } from "../correlation.js";
import { apiErrors, successEnvelope } from "../errors.js";
import type { OrganizationRepository } from "../mongo/organizations.js";

const OrganizationParamsSchema = z.strictObject({ organizationId: OrganizationIdSchema });
const OrganizationResultSchema = operationResult(CompanyEntitySchema);

interface OrganizationRoute {
  Params: { organizationId: string };
}

/** Authenticated single-tenant lookup of one organization entity. */
export function registerOrganizationRoutes(app: FastifyInstance, organizations: OrganizationRepository): void {
  app.get<OrganizationRoute>(
    "/v1/organizations/:organizationId",
    { preHandler: app.authenticate },
    async (request: FastifyRequest<OrganizationRoute>) => {
      if (Object.keys(request.query as Record<string, unknown>).length > 0) {
        throw apiErrors.validation("This endpoint does not accept query parameters");
      }

      const params = OrganizationParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw apiErrors.validation("Invalid organizationId path parameter");
      }

      // Tenant identity is taken only from verified claims; a mismatched path is
      // rejected before any lookup, so another tenant is never searched.
      const principal = requirePrincipal(request);
      if (principal.organizationId !== params.data.organizationId) {
        throw apiErrors.forbidden();
      }

      const organization = await organizations.findById(params.data.organizationId);
      if (!organization) {
        throw apiErrors.notFound("Organization not found");
      }

      return OrganizationResultSchema.parse(successEnvelope(correlationIdOf(request), organization));
    },
  );
}
