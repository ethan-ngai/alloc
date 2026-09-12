import type { OperationName } from "@alloc/contracts";
import { listActivity } from "./activity.js";
import type { AnyHandler } from "./context.js";
import { getForecast, runForecast } from "./forecasts.js";
import { ingestSource } from "./imports.js";
import { queryMemory } from "./memory.js";
import { correctPosting, recordPosting } from "./postings.js";
import { amendRequest, createRequest, getRequest } from "./requests.js";
import { decideReview } from "./reviews.js";

/**
 * Every catalogued operation has exactly one handler; `AnyHandler` erases the per-operation payload
 * type at the registry boundary only, and the router re-parses the response with the contract schema.
 */
export const HANDLERS: Readonly<Record<OperationName, AnyHandler>> = {
  "requests.create": createRequest,
  "requests.amend": amendRequest,
  "requests.get": getRequest,
  "reviews.decide": decideReview,
  "postings.record": recordPosting,
  "postings.correct": correctPosting,
  "imports.ingest": ingestSource,
  "memory.query": queryMemory,
  "forecasts.run": runForecast,
  "forecasts.get": getForecast,
  "activity.list": listActivity,
};
