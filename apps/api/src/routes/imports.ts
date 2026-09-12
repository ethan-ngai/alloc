import { CONTRACT_SCHEMA_VERSION, IngestSourceInputSchema, IngestSourceResultSchema, SourceDeliverySchema, type SourceDelivery } from "@alloc/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../auth/plugin.js";
import { correlationIdOf } from "../correlation.js";
import { apiErrors, successEnvelope } from "../errors.js";
import type { ImportRepository } from "../imports/repository.js";

const ParamsSchema = z.strictObject({ organizationId: z.string() });
interface ImportRoute { Params: { organizationId: string }; Body: unknown }

/** Ingestion is tenant-scoped and accepts the shared command envelope; its source payload never mutates financial projections. */
export function registerImportRoutes(app: FastifyInstance, imports: ImportRepository): void {
  app.post<ImportRoute>("/v1/organizations/:organizationId/imports", { preHandler: app.authenticate }, async (request: FastifyRequest<ImportRoute>) => {
    const params = ParamsSchema.safeParse(request.params);
    const input = IngestSourceInputSchema.safeParse(request.body);
    if (!params.success || !input.success || Object.keys(request.query as Record<string, unknown>).length) throw apiErrors.validation("Invalid import request");
    const principal = requirePrincipal(request);
    if (principal.organizationId !== params.data.organizationId || input.data.meta.organizationId !== principal.organizationId) throw apiErrors.forbidden();
    const delivery = { ...input.data.payload, schemaVersion: CONTRACT_SCHEMA_VERSION, organizationId: principal.organizationId } as SourceDelivery;
    const result = await imports.ingest(delivery);
    return IngestSourceResultSchema.parse(successEnvelope(correlationIdOf(request), result));
  });

  app.post<ImportRoute>("/v1/organizations/:organizationId/imports/csv", { preHandler: app.authenticate }, async (request: FastifyRequest<ImportRoute>) => {
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success || typeof request.body !== "string" || Object.keys(request.query as Record<string, unknown>).length) throw apiErrors.validation("Invalid CSV import request");
    const principal = requirePrincipal(request);
    if (principal.organizationId !== params.data.organizationId) throw apiErrors.forbidden();
    const delivery = csvDelivery(request.body);
    if (delivery.organizationId !== principal.organizationId) throw apiErrors.forbidden();
    return IngestSourceResultSchema.parse(successEnvelope(correlationIdOf(request), await imports.ingest(delivery)));
  });
}

/** CSV transport keeps one JSON delivery per row, avoiding a second lossy financial schema. */
function csvDelivery(csv: string): SourceDelivery {
  const rows = csv.trim().split(/\r?\n/);
  if (rows.length !== 2 || rows[0] !== "delivery") throw apiErrors.validation("CSV must contain exactly a delivery column and one row");
  try {
    return SourceDeliverySchema.parse(JSON.parse(rows[1]!));
  } catch {
    throw apiErrors.validation("CSV delivery is not a valid source envelope");
  }
}
