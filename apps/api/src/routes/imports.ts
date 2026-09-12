import { CONTRACT_SCHEMA_VERSION, IngestSourceInputSchema, IngestSourceResultSchema, PostingSchema, SourceDeliverySchema, operationResult, type SourceDelivery } from "@alloc/contracts";
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

  app.get<ImportRoute>("/v1/organizations/:organizationId/imports/postings", { preHandler: app.authenticate }, async (request: FastifyRequest<ImportRoute>) => {
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success || Object.keys(request.query as Record<string, unknown>).length) throw apiErrors.validation("Invalid import retrieval request");
    if (requirePrincipal(request).organizationId !== params.data.organizationId) throw apiErrors.forbidden();
    return operationResult(PostingSchema.array()).parse(successEnvelope(correlationIdOf(request), await imports.listPostings(params.data.organizationId)));
  });
}

/** CSV transport keeps one JSON delivery field, while still honoring CSV quoting rules. */
function csvDelivery(csv: string): SourceDelivery {
  const rows = parseCsv(csv);
  if (rows.length !== 2 || rows[0]?.length !== 1 || rows[0][0] !== "delivery" || rows[1]?.length !== 1) throw apiErrors.validation("CSV must contain exactly a delivery column and one row");
  try {
    return SourceDeliverySchema.parse(JSON.parse(rows[1]![0]!));
  } catch {
    throw apiErrors.validation("CSV delivery is not a valid source envelope");
  }
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [[]];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted && char === '"' && input[index + 1] === '"') { field += char; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") { rows.at(-1)!.push(field); field = ""; }
    else if (!quoted && (char === "\n" || char === "\r")) { if (char === "\r" && input[index + 1] === "\n") index += 1; rows.at(-1)!.push(field); rows.push([]); field = ""; }
    else field += char;
  }
  if (quoted) throw apiErrors.validation("CSV has an unterminated quoted field");
  rows.at(-1)!.push(field);
  return rows.at(-1)!.length === 1 && rows.at(-1)![0] === "" ? rows.slice(0, -1) : rows;
}
