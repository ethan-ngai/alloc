import { GetGraphContextInputSchema, GetGraphContextResultSchema, QueryMemoryInputSchema, QueryMemoryResultSchema } from "@alloc/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../auth/plugin.js";
import type { ContextRepository } from "../context/repository.js";
import type { GraphRepository } from "../context/graph.js";
import { correlationIdOf } from "../correlation.js";
import { apiErrors, successEnvelope } from "../errors.js";

const ParamsSchema = z.strictObject({ organizationId: z.string() });
interface ContextRoute { Params: { organizationId: string }; Body: unknown }

export function registerContextRoutes(app: FastifyInstance, context: ContextRepository, graph: GraphRepository): void {
  app.post<ContextRoute>("/v1/organizations/:organizationId/memory/query", { preHandler: app.authenticate }, async (request: FastifyRequest<ContextRoute>) => {
    const params = ParamsSchema.safeParse(request.params);
    const input = QueryMemoryInputSchema.safeParse(request.body);
    if (!params.success || !input.success || Object.keys(request.query as Record<string, unknown>).length) throw apiErrors.validation("Invalid memory query");
    const principal = requirePrincipal(request);
    if (principal.organizationId !== params.data.organizationId || input.data.meta.organizationId !== principal.organizationId) throw apiErrors.forbidden();
    const asOf = input.data.payload.asOf ?? new Date().toISOString();
    if (Date.parse(asOf) > Date.now()) throw apiErrors.validation("asOf cannot be in the future");
    const page = input.data.payload.page;
    return QueryMemoryResultSchema.parse(successEnvelope(correlationIdOf(request), await context.query(principal.organizationId, principal, { query: input.data.payload.query, scopes: input.data.payload.scopes, asOf, limit: page.limit, ...(page.cursor === undefined ? {} : { cursor: page.cursor }) })));
  });
  app.post<ContextRoute>("/v1/organizations/:organizationId/context/graph", { preHandler: app.authenticate }, async (request: FastifyRequest<ContextRoute>) => {
    const params = ParamsSchema.safeParse(request.params);
    const input = GetGraphContextInputSchema.safeParse(request.body);
    if (!params.success || !input.success || Object.keys(request.query as Record<string, unknown>).length) throw apiErrors.validation("Invalid graph query");
    const principal = requirePrincipal(request);
    if (principal.organizationId !== params.data.organizationId || input.data.meta.organizationId !== principal.organizationId) throw apiErrors.forbidden();
    const asOf = input.data.payload.asOf ?? new Date().toISOString();
    if (Date.parse(asOf) > Date.now()) throw apiErrors.validation("asOf cannot be in the future");
    return GetGraphContextResultSchema.parse(successEnvelope(correlationIdOf(request), await graph.query(principal.organizationId, principal, {
      subjectId: input.data.payload.subjectRef.id, relationshipTypes: input.data.payload.relationshipTypes,
      maxHops: input.data.payload.maxHops, maxEntities: input.data.payload.maxEntities, asOf,
    })));
  });
}
