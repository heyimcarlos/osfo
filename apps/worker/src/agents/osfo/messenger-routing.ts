import type { MessengerConversationResolver, MessengerEvent } from "@cloudflare/think/messengers";
import { Effect } from "effect";

import { OsfoAgent } from "./agent";
import {
  CompanyAgent,
  type CompanyConversationUnavailable,
  companyAddressKey,
} from "./company-agent";

/* oxlint-disable eslint/no-underscore-dangle -- Effect-style tagged unions use `_tag`. */

/** Current authority resolution for one normalized messenger address. */
export type MessengerAddressResolution =
  | { readonly _tag: "Linked"; readonly agentId: string }
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Unlinked" };

/** Product dependencies that map one messenger author to an Agent facet. */
export interface OsfoMessengerRoutingOptions {
  readonly hasAgent: (agentId: string) => boolean;
  readonly resolveAddress: (
    authorId: string,
    messengerId: string,
  ) => Effect.Effect<MessengerAddressResolution, CompanyConversationUnavailable>;
}

/**
 * Route one messenger conversation without taking ownership of transport
 * state. Linked senders reach their private Osfo Agent; unlinked direct-message
 * senders reach a temporary Company Conversation keyed by their address;
 * groups and unreadable events stay on the deterministic Directory.
 */
export const makeOsfoMessengerRouter =
  (options: OsfoMessengerRoutingOptions): MessengerConversationResolver =>
  (event: MessengerEvent) =>
    Effect.runPromise(routeMessengerEvent(event, options));

const routeMessengerEvent = Effect.fn("OsfoMessenger.route")(function* (
  event: MessengerEvent,
  options: OsfoMessengerRoutingOptions,
) {
  const authorId = event.author?.userId;
  if (authorId === undefined || !event.thread.isDirectMessage) return { target: "self" as const };
  const resolution = yield* options.resolveAddress(authorId, event.messengerId);
  if (resolution._tag === "Linked") {
    return options.hasAgent(resolution.agentId)
      ? { agentClass: OsfoAgent, name: resolution.agentId, target: "subagent" as const }
      : { target: "self" as const };
  }
  if (resolution._tag === "Unavailable") return { target: "self" as const };
  return {
    agentClass: CompanyAgent,
    name: yield* companyAddressKey(event.messengerId, authorId),
    target: "subagent" as const,
  };
});
