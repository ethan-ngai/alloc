import { CorrectPostingInputSchema, CorrectPostingResultSchema, RecordPostingInputSchema, RecordPostingResultSchema } from "@alloc/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../auth/plugin.js";
import { correlationIdOf } from "../correlation.js";
import { apiErrors, successEnvelope } from "../errors.js";
import type { FinancialContext } from "../finance/internal.js";
import type { FinancialRepository } from "../finance/repository.js";

const OrganizationParamsSchema = z.strictObject({ organizationId: z.string() });
const NoQuery = z.strictObject({});

interface OrganizationRoute { Params: { organizationId: string }; Body: unknown }

function assertNoQuery(request: FastifyRequest): void {
  if (!NoQuery.safeParse(request.query ?? {}).success) {
    throw apiErrors.validation("This endpoint does not accept query parameters");
  }
}

/** Direct posting and compensating correction, both requiring finance_manager authority. */
export function registerPostingRoutes(app: FastifyInstance, finance: FinancialRepository): void {
  app.post<OrganizationRoute>("/v1/organizations/:organizationId/postings", { preHandler: app.authenticate }, async (request) => {
    const params = OrganizationParamsSchema.safeParse(request.params);
    const input = RecordPostingInputSchema.safeParse(request.body);
    assertNoQuery(request);
    if (!params.success || !input.success) throw apiErrors.validation("Invalid posting command");
    const principal = requirePrincipal(request);
    if (principal.organizationId !== params.data.organizationId || input.data.meta.organizationId !== principal.organizationId) {
      throw apiErrors.forbidden();
    }
    const context: FinancialContext = { principalId: principal.principalId, organizationId: principal.organizationId, roles: principal.roles };
    const posting = await finance.recordPosting(context, input.data);
    return RecordPostingResultSchema.parse(successEnvelope(correlationIdOf(request), posting));
  });

  app.post<OrganizationRoute>("/v1/organizations/:organizationId/posting-corrections", { preHandler: app.authenticate }, async (request) => {
    const params = OrganizationParamsSchema.safeParse(request.params);
    const input = CorrectPostingInputSchema.safeParse(request.body);
    assertNoQuery(request);
    if (!params.success || !input.success) throw apiErrors.validation("Invalid correction command");
    const principal = requirePrincipal(request);
    if (principal.organizationId !== params.data.organizationId || input.data.meta.organizationId !== principal.organizationId) {
      throw apiErrors.forbidden();
    }
    const context: FinancialContext = { principalId: principal.principalId, organizationId: principal.organizationId, roles: principal.roles };
    const correction = await finance.correctPosting(context, input.data);
    return CorrectPostingResultSchema.parse(successEnvelope(correlationIdOf(request), correction));
  });
}
