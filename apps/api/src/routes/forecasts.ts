import { GetForecastResultSchema, type ForecastSnapshot } from "@alloc/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../auth/plugin.js";
import { correlationIdOf } from "../correlation.js";
import { apiErrors, successEnvelope } from "../errors.js";
import type { ForecastRepository } from "../forecasts/repository.js";

const ParamsSchema = z.strictObject({ organizationId: z.string(), forecastId: z.string() });
const QuerySchema = z.strictObject({ revision: z.coerce.number().int().positive().optional() });
interface ForecastRoute { Params: { organizationId: string; forecastId: string }; Querystring: { revision?: string } }

/** Current is the default; a linked prior revision is available by its immutable revision number. */
export function registerForecastRoutes(app: FastifyInstance, forecasts: ForecastRepository): void {
  app.get<ForecastRoute>("/v1/organizations/:organizationId/forecasts/:forecastId", { preHandler: app.authenticate }, async (request: FastifyRequest<ForecastRoute>) => {
    const params = ParamsSchema.safeParse(request.params);
    const query = QuerySchema.safeParse(request.query);
    if (!params.success || !query.success) throw apiErrors.validation("Invalid forecast retrieval request");
    if (requirePrincipal(request).organizationId !== params.data.organizationId) throw apiErrors.forbidden();
    const snapshot = await forecasts.get(params.data.organizationId, params.data.forecastId, query.data.revision);
    if (!snapshot) throw apiErrors.notFound("Forecast not found");
    return GetForecastResultSchema.parse(successEnvelope(correlationIdOf(request), snapshot));
  });
}
