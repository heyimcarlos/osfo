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

/** Expected failure when a stable Agent has no User owner. */
export class AgentOwnerNotFound extends Schema.TaggedError<AgentOwnerNotFound>()(
  "AgentOwnerNotFound",
  { agentId: AgentId, message: Schema.String },
) {}

/** Stable Agent directory operations. */
export interface Interface {
  readonly resolveAgent: (
    agentId: AgentId,
  ) => Effect.Effect<AgentRoute, AgentOwnerNotFound | DbUnavailable>;
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
        .select({ agentId: agents.agent_id, userId: agents.user_id })
        .from(agents)
        .where(eq(agents.user_id, userId))
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

  const resolveAgent = Effect.fn("AgentDirectory.resolveAgent")(function* (agentId: AgentId) {
    const rows = yield* execute("resolveAgentOwner", () =>
      db
        .select({ agentId: agents.agent_id, userId: agents.user_id })
        .from(agents)
        .where(eq(agents.agent_id, agentId))
        .limit(1)
        .execute(),
    );
    const route = rows[0];
    if (route === undefined) {
      return yield* new AgentOwnerNotFound({
        agentId,
        message: "No stable User owner exists for the Agent",
      });
    }
    return yield* decodeRow(AgentRoute, route, "resolveAgentOwner");
  });

  return Service.of({ resolve, resolveAgent });
});

/** Agent directory Layer that preserves its database requirement. */
export const layerWithoutDependencies = Layer.effect(Service, make);

export * as AgentDirectory from "./agent-directory";
