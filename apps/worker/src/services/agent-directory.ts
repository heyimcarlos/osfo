import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { database, dbUnavailable, decodeRow } from "../db";
import { agents } from "../db/schema";
import { AgentId, UserId } from "../domain";

/** Stable route from a User to the User-scoped Osfo Agent. */
export const AgentRoute = Schema.Struct({
  agentId: AgentId,
  userId: UserId,
});

/** Stable route from a User to the User-scoped Osfo Agent. */
export type AgentRoute = typeof AgentRoute.Type;

/** Expected failure when a stable Agent route does not exist. */
export class AgentRouteNotFound extends Schema.TaggedError<AgentRouteNotFound>()(
  "AgentRouteNotFound",
  { message: Schema.String, userId: UserId },
) {}

/** Resolve the stable Agent route for one User. */
export const resolveAgent = Effect.fn("AgentDirectory.resolveAgent")(function* (userId: UserId) {
  const db = yield* database;
  const rows = yield* db
    .select({ agentId: agents.agentId, userId: agents.userId })
    .from(agents)
    .where(eq(agents.userId, userId))
    .limit(1)
    .pipe(Effect.mapError((cause) => dbUnavailable("resolveAgent", cause)));
  const route = rows[0];
  if (route === undefined) {
    return yield* new AgentRouteNotFound({
      message: "No stable Agent route exists for the User",
      userId,
    });
  }
  return yield* decodeRow(AgentRoute, route, "resolveAgent");
});
