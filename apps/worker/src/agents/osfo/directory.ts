import { BrowserCrypto } from "@effect/platform-browser";
import { Think, type StreamCallback, type ThinkChannels } from "@cloudflare/think";
import type { MessengerContext } from "@cloudflare/think/messengers";
import type { UIMessage } from "ai";
import { Effect, Exit, Layer, Schema } from "effect";

import { loadConfig } from "../../config";
import { Db } from "../../db";
import { makeTelegramChannel } from "../../integrations/telegram";
import { makeWhatsAppChannel } from "../../integrations/whatsapp";
import { invalidOsfoEnvironment, type RuntimeProbeResult } from "../../layers";
import type { RuntimeSecrets } from "../../runtime-secrets";
import { AgentDirectory } from "../../services/agent-directory";
import { ChannelLinks } from "../../services/channel-links";
import { OsfoAgent } from "./agent";
import { channelAddressOf, messengerAuthorId } from "./channel-address";
import { CompanyAgent } from "./company-agent";
import { makeOsfoMessengerRouter, type MessengerAddressResolution } from "./messenger-routing";
import type { AgentInitializationEncoded } from "./db/store";
import { GroupRefusalCopy } from "./persona";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- Think RPC methods use Promise contracts, this class is the messenger Layer composition root, and Effect results use _tag. */

export { OSFO_DIRECTORY_NAME } from "./identity";

const StreamTextDelta = Schema.fromJsonString(
  Schema.Struct({ delta: Schema.String, type: Schema.Literals(["text-delta"]) }),
);

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
      resolveAddress: (authorId, messengerId) =>
        Effect.scoped(
          this.#resolveMessengerAddress(messengerId, authorId).pipe(
            Effect.provide(directoryMessengerLayer(this.env)),
          ),
        ),
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
  override chatWithMessengerContext(
    _userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerContext,
  ): Promise<void> {
    return Effect.runPromise(
      Effect.scoped(
        replyToDirectoryGate(callback, context).pipe(
          Effect.provide(directoryMessengerLayer(this.env)),
        ),
      ),
    );
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

  #resolveMessengerAddress = Effect.fn("OsfoDirectory.resolveMessengerAddress")(
    { self: this },
    function* (this: OsfoDirectory, messengerId: string, authorId: string) {
      const channelLinks = yield* ChannelLinks.Service;
      const agentDirectory = yield* AgentDirectory.Service;
      const resolved = yield* Effect.exit(
        Effect.gen(function* () {
          const link = yield* channelLinks.resolve(channelAddressOf(messengerId, authorId));
          if (link === null) return { _tag: "Unlinked" as const };
          const route = yield* agentDirectory
            .resolve(link.userId)
            .pipe(Effect.catchTag("AgentRouteNotFound", () => Effect.succeed(null)));
          return route === null
            ? { _tag: "Unavailable" as const }
            : { _tag: "Linked" as const, agentId: route.agentId };
        }),
      );
      if (Exit.isFailure(resolved)) return { _tag: "Unavailable" as const };
      if (
        resolved.value._tag === "Linked" &&
        !this.hasSubAgent(OsfoAgent, resolved.value.agentId)
      ) {
        return { _tag: "Unavailable" as const };
      }
      return resolved.value satisfies MessengerAddressResolution;
    },
  );
}

/**
 * Deterministically gate a directory messenger turn before any model or User
 * authority exists. Unlinked direct-message senders never land here: the
 * conversation resolver routes them to their Company Conversation facet.
 */
export const replyToDirectoryGate = Effect.fn("OsfoDirectory.replyToMessenger")(function* (
  callback: StreamCallback,
  context: MessengerContext,
) {
  // Think hands messenger turns its serializable event snapshot, which carries
  // the author inside the message rather than at the context top level.
  const authorId = messengerAuthorId(context);
  const message = context.message;
  if (authorId === undefined || message === undefined) {
    yield* streamReply(
      callback,
      "channel-address-unreadable",
      "I could not read that message. Please try again.",
    );
    return;
  }
  if (!context.thread.isDirectMessage) {
    yield* streamReply(callback, message.id, `${GroupRefusalCopy.en}\n${GroupRefusalCopy.es}`);
    return;
  }
  const channelLinks = yield* ChannelLinks.Service;
  const resolved = yield* Effect.exit(
    channelLinks.resolve(channelAddressOf(context.messengerId, authorId)),
  );
  const linked = Exit.isSuccess(resolved) && resolved.value !== null;
  if (linked) {
    yield* streamReply(
      callback,
      message.id,
      "This channel is linked, but I could not reach your Osfo Agent. Please try again.",
    );
    return;
  }
  yield* streamReply(callback, message.id, "Please send that message again.");
});

const streamReply = Effect.fn("OsfoDirectory.streamReply")(function* (
  callback: StreamCallback,
  requestId: string,
  text: string,
) {
  yield* Effect.tryPromise(() => Promise.resolve(callback.onStart({ requestId })));
  yield* Effect.tryPromise(() => Promise.resolve(callback.onEvent(encodeTextDelta(text))));
  yield* Effect.tryPromise(() => Promise.resolve(callback.onDone()));
});

const directoryMessengerLayer = (env: Env & RuntimeSecrets) => {
  const config = loadConfig(env);
  const base = Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer);
  return Layer.merge(
    ChannelLinks.layerFromConfig(config),
    AgentDirectory.layerWithoutDependencies,
  ).pipe(Layer.provide(base));
};

const encodeTextDelta = (delta: string) =>
  Schema.encodeSync(StreamTextDelta)({ delta, type: "text-delta" });
