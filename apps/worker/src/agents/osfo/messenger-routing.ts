import type { MessengerConversationResolver, MessengerEvent } from "@cloudflare/think/messengers";
import { Effect } from "effect";

import type { ChannelLinks } from "../../services/channel-links";
import { OsfoAgent } from "./agent";
import { channelAddressOf } from "./channel-address";
import { CompanyAgent, companyAddressKey } from "./company-agent";

/* oxlint-disable eslint/no-underscore-dangle -- Effect-style tagged unions use `_tag`. */

/** Current authority resolution for one normalized messenger address. */
export type MessengerAddressResolution =
  | { readonly _tag: "Linked"; readonly agentId: string }
  | { readonly _tag: "Unavailable" }
  | {
      readonly _tag: "Unlinked";
      readonly previousChannelLinkId: ChannelLinks.ChannelLinkId | null;
    };

/** Product dependencies that map one messenger author to an Agent facet. */
export interface OsfoMessengerRoutingOptions {
  readonly hasAgent: (agentId: string) => boolean;
  readonly resolveAddress: (
    address: typeof ChannelLinks.ChannelAddress.Type,
  ) => Effect.Effect<MessengerAddressResolution>;
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
  const address = channelAddressOf(event.messengerId, authorId);
  const resolution = yield* options.resolveAddress(address);
  if (resolution._tag === "Linked") {
    return options.hasAgent(resolution.agentId)
      ? { agentClass: OsfoAgent, name: resolution.agentId, target: "subagent" as const }
      : { target: "self" as const };
  }
  if (resolution._tag === "Unavailable") return { target: "self" as const };
  return {
    agentClass: CompanyAgent,
    name: yield* companyAddressKey(address, resolution.previousChannelLinkId),
    target: "subagent" as const,
  };
});
