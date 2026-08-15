import { agents } from "@osfo/db/schema/agents";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { database, decodeRow, type DbUnavailable, execute } from "../db";
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

/** Stable Agent directory operations. */
export interface Interface {
  readonly resolve: (
    userId: UserId,
  ) => Effect.Effect<AgentRoute, AgentRouteNotFound | DbUnavailable>;
}

/** Stable directory from a User to the User-scoped Osfo Agent. */
export class Service extends Context.Service<Service, Interface>()("@osfo/AgentDirectory") {}

/** Construct the Agent directory from the current request-scoped database. */
export const make = Effect.gen(function* () {
  const db = yield* database;

  const resolve = Effect.fn("AgentDirectory.resolve")(function* (userId: UserId) {
    const rows = yield* execute("resolveAgent", () =>
      db
        .select({ agentId: agents.agentId, userId: agents.userId })
        .from(agents)
        .where(eq(agents.userId, userId))
        .limit(1)
        .execute(),
    );
    const route = rows[0];
    if (route === undefined) {
      return yield* new AgentRouteNotFound({
        message: "No stable Agent route exists for the User",
        userId,
      });
    }
    return yield* decodeRow(AgentRoute, route, "resolveAgent");
  });

  return Service.of({ resolve });
});

/** Agent directory Layer that preserves its database requirement. */
export const layerWithoutDependencies = Layer.effect(Service, make);
