import { BrowserCrypto } from "@effect/platform-browser";
import { Think, type StreamCallback, type ThinkChannels } from "@cloudflare/think";
import type { MessengerContext } from "@cloudflare/think/messengers";
import type { UIMessage } from "ai";
import { Effect, Exit, Layer } from "effect";

import { loadConfig } from "../../config";
import { Db } from "../../db";
import { makeTelegramChannel } from "../../integrations/telegram";
import { makeWhatsAppChannel } from "../../integrations/whatsapp";
import { invalidOsfoEnvironment, type RuntimeProbeResult } from "../../layers";
import type { RuntimeSecrets } from "../../runtime-secrets";
import { AgentDirectory } from "../../services/agent-directory";
import { ChannelLinks } from "../../services/channel-links";
import { OsfoAgent } from "./agent";
import { CompanyAgent, channelAddressOf } from "./company-agent";
import { makeOsfoMessengerRouter } from "./messenger-routing";
import type { AgentInitializationEncoded } from "./db/store";
import { GroupRefusalCopy } from "./persona";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- Think hooks and RPC use Promise boundaries, messenger turns are application entry points, and Effect results use _tag. */

export { OSFO_DIRECTORY_NAME } from "./identity";

/** Root Agent that owns the registry of user-scoped Osfo Agent facets. */
export class OsfoDirectory extends Think<Env & RuntimeSecrets> {
  /** Keep the directory model dormant. User turns run only on child facets. */
  override getModel() {
    return "@cf/openai/gpt-oss-120b";
  }

  /** Configure the shared messenger webhooks and their conversation resolvers. */
  override configureChannels(): ThinkChannels {
    const conversation = makeOsfoMessengerRouter({
      hasAgent: (agentId) => this.hasSubAgent(OsfoAgent, agentId),
      resolveAgentId: (authorId, messengerId) => this.#resolveAgentId(messengerId, authorId),
    });
    return {
      telegram: makeTelegramChannel({
        conversation,
        secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        token: this.env.TELEGRAM_BOT_TOKEN,
        userName: this.env.TELEGRAM_BOT_USERNAME,
      }),
      whatsapp: makeWhatsAppChannel({
        accessToken: this.env.WHATSAPP_ACCESS_TOKEN,
        appSecret: this.env.WHATSAPP_APP_SECRET,
        conversation,
        phoneNumberId: this.env.WHATSAPP_PHONE_NUMBER_ID,
        userName: this.env.WHATSAPP_BOT_USERNAME,
        verifyToken: this.env.WHATSAPP_VERIFY_TOKEN,
      }),
    };
  }

  /** Deterministically answer the messenger turns that never reach a facet. */
  override async chatWithMessengerContext(
    _userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerContext,
  ): Promise<void> {
    await replyToDirectoryGate(callback, context, {
      resolveLinked: async (address) => {
        const resolved = await Effect.runPromiseExit(
          this.#withChannelLinks((channelLinks) => channelLinks.resolve(address)),
        );
        if (Exit.isFailure(resolved)) return null;
        return resolved.value !== null;
      },
    });
  }

  /** Reject an HTTP route to a facet that is absent from the directory registry. */
  override async onBeforeSubAgent(
    _request: Request,
    target: { readonly className: string; readonly name: string },
  ): Promise<Response | void> {
    if (target.className !== OsfoAgent.name || !this.hasSubAgent(target.className, target.name)) {
      return new Response("Agent not found", { status: 404 });
    }
  }

  /** Create the user-owned facet when necessary and return its registry identity. */
  async ensureAgent(
    agentId: string,
  ): Promise<{ readonly className: string; readonly name: string }> {
    await this.subAgent(OsfoAgent, agentId);
    return { className: OsfoAgent.name, name: agentId };
  }

  /** Create the company conversation facet when necessary and return its registry identity. */
  async ensureCompanyConversation(
    addressKey: string,
  ): Promise<{ readonly className: string; readonly name: string }> {
    await this.subAgent(CompanyAgent, addressKey);
    return { className: CompanyAgent.name, name: addressKey };
  }

  /** Initialize one registered user-owned facet. */
  async initializeAgent(agentId: string, input: AgentInitializationEncoded) {
    const agent = await this.subAgent(OsfoAgent, agentId);
    const result = await agent.initialize(input);
    return { _tag: result._tag };
  }

  /** Probe one registered facet runtime for local smoke verification. */
  async probeAgent(agentId: string): Promise<RuntimeProbeResult> {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return invalidOsfoEnvironment;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.probeRuntime();
  }

  /** Inspect one registered user-owned facet without exposing it to a browser. */
  async inspectAgent(agentId: string) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    const result = await agent.inspect();
    return result._tag === "AgentFound"
      ? {
          agentId: result.agentId,
          currentSessionId: result.currentSessionId,
          routeId: result.routeId,
        }
      : null;
  }

  /** List the authoritative user-owned facet registry. */
  listAgents(): ReadonlyArray<{ readonly className: string; readonly name: string }> {
    return this.listSubAgents(OsfoAgent).map(({ className, name }) => ({ className, name }));
  }

  /** Delete one user-owned facet and its SQLite state. */
  async deleteAgent(agentId: string): Promise<void> {
    await this.deleteSubAgent(OsfoAgent, agentId);
  }

  async #resolveAgentId(messengerId: string, authorId: string): Promise<string | null> {
    const resolved = await Effect.runPromiseExit(
      this.#withChannelLinks((channelLinks, agentDirectory) =>
        Effect.gen(function* () {
          const link = yield* channelLinks.resolve(channelAddressOf(messengerId, authorId));
          if (link === null) return null;
          return yield* agentDirectory
            .resolve(link.userId)
            .pipe(Effect.catchTag("AgentRouteNotFound", () => Effect.succeed(null)));
        }),
      ),
    );
    if (
      Exit.isFailure(resolved) ||
      resolved.value === null ||
      !this.hasSubAgent(OsfoAgent, resolved.value.agentId)
    ) {
      return null;
    }
    return resolved.value.agentId;
  }

  #withChannelLinks<A, E>(
    operation: (
      channelLinks: ChannelLinks.Interface,
      agentDirectory: AgentDirectory.Interface,
    ) => Effect.Effect<A, E>,
  ) {
    const config = loadConfig(this.env);
    const base = Layer.merge(Db.layer({ db: this.env.DB }), BrowserCrypto.layer);
    const services = Layer.merge(
      ChannelLinks.layerFromConfig(config),
      AgentDirectory.layerWithoutDependencies,
    ).pipe(Layer.provide(base));
    return Effect.scoped(
      Effect.gen(function* () {
        const channelLinks = yield* ChannelLinks.Service;
        const agentDirectory = yield* AgentDirectory.Service;
        return yield* operation(channelLinks, agentDirectory);
      }).pipe(Effect.provide(services)),
    );
  }
}

interface DirectoryGateDependencies {
  /** Read current Channel Link authority; null means the authority is unreadable. */
  readonly resolveLinked: (
    address: typeof ChannelLinks.ChannelAddress.Type,
  ) => Promise<boolean | null>;
}

/**
 * Deterministically gate a directory messenger turn before any model or User
 * authority exists. Unlinked direct-message senders never land here: the
 * conversation resolver routes them to their Company Conversation facet.
 */
export const replyToDirectoryGate = async (
  callback: StreamCallback,
  context: MessengerContext,
  dependencies: DirectoryGateDependencies,
): Promise<void> => {
  // Think hands messenger turns its serializable event snapshot, which carries
  // the author inside the message rather than at the context top level.
  const authorId = context.message?.author.userId ?? context.author?.userId;
  const message = context.message;
  if (authorId === undefined || message === undefined) {
    await streamReply(
      callback,
      "channel-address-unreadable",
      "I could not read that message. Please try again.",
    );
    return;
  }
  if (!context.thread.isDirectMessage) {
    await streamReply(callback, message.id, GroupRefusalCopy.en);
    return;
  }
  const linked = await dependencies.resolveLinked(channelAddressOf(context.messengerId, authorId));
  if (linked) {
    await streamReply(
      callback,
      message.id,
      "This channel is linked, but I could not reach your Osfo Agent. Please try again.",
    );
    return;
  }
  await streamReply(callback, message.id, "Please send that message again.");
};

const streamReply = async (callback: StreamCallback, requestId: string, text: string) => {
  await callback.onStart({ requestId });
  await callback.onEvent(JSON.stringify({ delta: text, type: "text-delta" }));
  await callback.onDone();
};
