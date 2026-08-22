import type { MessengerConversationResolver, MessengerEvent } from "@cloudflare/think/messengers";

import { OsfoAgent } from "./agent";
import { CompanyAgent, companyAddressKey } from "./company-agent";

/* oxlint-disable effecttsgo/async-function -- The Think conversation resolver is Promise-based. */

/** Product dependencies that map one messenger author to an Agent facet. */
export interface OsfoMessengerRoutingOptions {
  readonly hasAgent: (agentId: string) => boolean;
  readonly resolveAgentId: (authorId: string, messengerId: string) => Promise<string | null>;
}

/**
 * Route one messenger conversation without taking ownership of transport
 * state. Linked senders reach their private Osfo Agent; unlinked direct-message
 * senders reach a temporary Company Conversation keyed by their address;
 * groups and unreadable events stay on the deterministic Directory.
 */
export const makeOsfoMessengerRouter =
  (options: OsfoMessengerRoutingOptions): MessengerConversationResolver =>
  async (event: MessengerEvent) => {
    const authorId = event.author?.userId;
    if (authorId === undefined || !event.thread.isDirectMessage) return { target: "self" };
    const agentId = await options.resolveAgentId(authorId, event.messengerId);
    if (agentId !== null) {
      return options.hasAgent(agentId)
        ? { agentClass: OsfoAgent, name: agentId, target: "subagent" as const }
        : { target: "self" as const };
    }
    return {
      agentClass: CompanyAgent,
      name: await companyAddressKey(event.messengerId, authorId),
      target: "subagent" as const,
    };
  };
