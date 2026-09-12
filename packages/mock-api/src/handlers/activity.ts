import { paginate, scopesIntersect } from "./context.js";
import type { Handler } from "./context.js";

export const listActivity: Handler<"activity.list"> = (ctx, payload) => {
  const records = ctx.company.activity.filter((record) => (
    (payload.scopes.length === 0 || scopesIntersect(record.scopeRefs, payload.scopes))
    && (payload.since === undefined || Date.parse(record.item.occurredAt) >= Date.parse(payload.since))
  ));
  const items = records
    .map((record) => record.item)
    .sort((left, right) => {
      const byTime = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
      if (byTime !== 0) return byTime;
      return left.activityId < right.activityId ? 1 : left.activityId > right.activityId ? -1 : 0;
    });
  const page = paginate(items, payload.page);
  return { items: page.items, page: page.page };
};
