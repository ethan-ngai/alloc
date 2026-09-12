import {
  AmendRequestInputSchema, AmendRequestResultSchema, CreateRequestInputSchema, CreateRequestResultSchema,
  DecideReviewInputSchema, DecideReviewResultSchema, GetRequestResultSchema,
} from "@alloc/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../auth/plugin.js";
import type { Principal } from "../auth/principal.js";
import { correlationIdOf } from "../correlation.js";
import { apiErrors, successEnvelope } from "../errors.js";
import type { FinancialContext } from "../finance/internal.js";
import type { FinancialRepository } from "../finance/repository.js";

const OrganizationParamsSchema = z.strictObject({ organizationId: z.string() });
const RequestParamsSchema = z.strictObject({ organizationId: z.string(), requestId: z.string() });
const NoQuery = z.strictObject({});

interface OrganizationRoute { Params: { organizationId: string }; Body: unknown }
interface RequestRoute { Params: { organizationId: string; requestId: string }; Body: unknown }

function financialContext(principal: Principal): FinancialContext {
  return { principalId: principal.principalId, organizationId: principal.organizationId, roles: principal.roles };
}

function assertNoQuery(request: FastifyRequest): void {
  if (!NoQuery.safeParse(request.query ?? {}).success) {
    throw apiErrors.validation("This endpoint does not accept query parameters");
  }
}

/** Authenticated request lifecycle: create, amend, read, and decide a human review. */
export function registerRequestRoutes(app: FastifyInstance, finance: FinancialRepository): void {
  app.post<OrganizationRoute>("/v1/organizations/:organizationId/requests", { preHandler: app.authenticate }, async (request) => {
    const params = OrganizationParamsSchema.safeParse(request.params);
    const input = CreateRequestInputSchema.safeParse(request.body);
    assertNoQuery(request);
    if (!params.success || !input.success) throw apiErrors.validation("Invalid create-request command");
    const principal = requirePrincipal(request);
    if (principal.organizationId !== params.data.organizationId || input.data.meta.organizationId !== principal.organizationId) {
      throw apiErrors.forbidden();
    }
    const revision = await finance.createRequest(financialContext(principal), input.data);
    return CreateRequestResultSchema.parse(successEnvelope(correlationIdOf(request), revision));
  });

  app.post<RequestRoute>("/v1/organizations/:organizationId/requests/:requestId/amendments", { preHandler: app.authenticate }, async (request) => {
    const params = RequestParamsSchema.safeParse(request.params);
    const input = AmendRequestInputSchema.safeParse(request.body);
    assertNoQuery(request);
    if (!params.success || !input.success || input.data.payload.requestId !== params.data.requestId) {
      throw apiErrors.validation("Invalid amend-request command");
    }
    const principal = requirePrincipal(request);
    if (principal.organizationId !== params.data.organizationId || input.data.meta.organizationId !== principal.organizationId) {
      throw apiErrors.forbidden();
    }
    const result = await finance.amendRequest(financialContext(principal), input.data);
    return AmendRequestResultSchema.parse(successEnvelope(correlationIdOf(request), result));
  });

  app.get<RequestRoute>("/v1/organizations/:organizationId/requests/:requestId", { preHandler: app.authenticate }, async (request) => {
    const params = RequestParamsSchema.safeParse(request.params);
    assertNoQuery(request);
    if (!params.success) throw apiErrors.validation("Invalid request path parameters");
    const principal = requirePrincipal(request);
    if (principal.organizationId !== params.data.organizationId) throw apiErrors.forbidden();
    const view = await finance.getRequest(params.data.organizationId, params.data.requestId);
    if (!view) throw apiErrors.notFound("Request not found");
    return GetRequestResultSchema.parse(successEnvelope(correlationIdOf(request), view));
  });

  app.post<RequestRoute>("/v1/organizations/:organizationId/requests/:requestId/reviews", { preHandler: app.authenticate }, async (request) => {
    const params = RequestParamsSchema.safeParse(request.params);
    const input = DecideReviewInputSchema.safeParse(request.body);
    assertNoQuery(request);
    if (!params.success || !input.success || input.data.payload.requestId !== params.data.requestId) {
      throw apiErrors.validation("Invalid review command");
    }
    const principal = requirePrincipal(request);
    if (principal.organizationId !== params.data.organizationId || input.data.meta.organizationId !== principal.organizationId) {
      throw apiErrors.forbidden();
    }
    const result = await finance.decideReview(financialContext(principal), input.data);
    return DecideReviewResultSchema.parse(successEnvelope(correlationIdOf(request), result));
  });
}
