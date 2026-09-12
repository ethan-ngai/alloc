import { z } from "zod";
import { IdSchema, PrioritySchema, TimestampSchema } from "@alloc/contracts";

export const InferenceRequestSchema = z.strictObject({
  requestId: IdSchema,
  jobId: IdSchema,
  childTaskId: IdSchema.nullable(),
  priority: PrioritySchema,
  queuedAt: TimestampSchema,
});

export type InferenceRequest = z.infer<typeof InferenceRequestSchema>;

export function selectNextInference(
  requestsInput: readonly InferenceRequest[],
): InferenceRequest | null {
  const rank = { P0: 0, P1: 1, P2: 2 } as const;
  const requests = requestsInput.map((request) => InferenceRequestSchema.parse(request));
  return requests.sort((left, right) =>
    rank[left.priority] - rank[right.priority]
    || Date.parse(left.queuedAt) - Date.parse(right.queuedAt)
    || left.requestId.localeCompare(right.requestId)
  )[0] ?? null;
}

/** Single-process reference for the initial global one-generation limit. */
export class SingleInferenceSlot {
  #active: InferenceRequest | null = null;

  get active(): InferenceRequest | null {
    return this.#active === null ? null : InferenceRequestSchema.parse(this.#active);
  }

  acquire(requestInput: InferenceRequest): boolean {
    const request = InferenceRequestSchema.parse(requestInput);
    if (this.#active !== null) return false;
    this.#active = request;
    return true;
  }

  release(requestId: string): void {
    if (this.#active?.requestId !== requestId) {
      throw new Error("only the active inference request can release the slot");
    }
    this.#active = null;
  }
}
