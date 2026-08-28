import { BrowserCrypto } from "@effect/platform-browser";
import { Think, type StreamCallback, type ThinkChannels } from "@cloudflare/think";
import type { MessengerContext } from "@cloudflare/think/messengers";
import type { UIMessage } from "ai";
import type { SkillChangeRequest, SkillDeletionRequest } from "@osfo/api";
import { Effect, Layer, Option, Redacted, Schema } from "effect";

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
import { streamTextReply } from "./messenger-stream";
import { makeOsfoMessengerRouter, type MessengerAddressResolution } from "./messenger-routing";
import type { AgentInitializationEncoded } from "./db/store";
import { GroupRefusalCopy } from "./persona";
import { UserId } from "../../domain";
import { AuthSessionId } from "../../domain/auth-session";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- Think RPC methods use Promise contracts, this class is the messenger Layer composition root, and Effect results use _tag. */

export { OSFO_DIRECTORY_NAME } from "./identity";

/** Root Agent that owns the registry of user-scoped Osfo Agent facets. */
export class OsfoDirectory extends Think<Env & RuntimeSecrets> {
  /** Keep the directory model dormant. User turns run only on child facets. */
  override getModel() {
    return "@cf/openai/gpt-oss-120b";
  }

  /** Configure the shared messenger webhooks and their conversation resolvers. */
  override configureChannels(): ThinkChannels {
    const config = loadConfig(this.env);
    const conversation = makeOsfoMessengerRouter({
      hasAgent: (agentId) => this.hasSubAgent(OsfoAgent, agentId),
      resolveAddress: (address) =>
        Effect.scoped(
          this.#resolveMessengerAddress(address).pipe(
            Effect.provide(directoryMessengerLayer(this.env)),
          ),
        ),
    });
    return {
      telegram: makeTelegramChannel({
        apiBaseURL: config.telegram.apiBaseURL,
        conversation,
        secretToken: Redacted.value(config.telegram.webhookSecret),
        token: Redacted.value(config.telegram.botToken),
        userName: config.telegram.botUsername,
      }),
      whatsapp: makeWhatsAppChannel({
        accessToken: this.env.WHATSAPP_ACCESS_TOKEN,
        apiUrl: config.whatsApp.apiBaseURL,
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

  /** Inspect one committed Reminder source through its owning User Agent. */
  async inspectReminderWakeUpSource(userId: string, sourceIdentity: string) {
    const agent = await this.#agentForUser(userId);
    return agent === null ? null : agent.inspectReminderWakeUpSource(userId, sourceIdentity);
  }

  /** List Reminder source identities awaiting the User's normal inbound turn. */
  async pendingReminderWakeUpSources(userId: string) {
    const agent = await this.#agentForUser(userId);
    return agent === null ? [] : agent.pendingReminderWakeUpSources(userId);
  }

  /** Commit an exact Reminder source exposure snapshot in its owning User Agent. */
  async exposeReminderWakeUpSources(
    userId: string,
    // oxlint-disable-next-line osfo/no-unknown-parameters -- The owning Agent schema-decodes this Directory RPC payload before use.
    committed: unknown,
  ): Promise<void> {
    const agent = await this.#agentForUser(userId);
    if (agent === null) return;
    await agent.exposeReminderWakeUpSources(userId, committed);
  }

  /** List current personal Skills through one registered User Agent. */
  async inspectPersonalSkills(
    agentId: string,
    actor: { readonly decisionReference: string; readonly userId: string },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.inspectPersonalSkills({ ...actor, userId: UserId.make(actor.userId) });
  }

  /** Inspect safe Integration Connection state through one registered User Agent. */
  async inspectIntegrationConnections(
    agentId: string,
    actor: { readonly authSessionId: string; readonly userId: string },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.inspectIntegrationConnections({
      authSessionId: AuthSessionId.make(actor.authSessionId),
      userId: UserId.make(actor.userId),
    });
  }

  /** Acquire one provider-hosted Integration Connect Link. */
  async connectIntegrationFromSettings(
    agentId: string,
    input: {
      readonly actor: { readonly authSessionId: string; readonly userId: string };
      readonly callbackUrl: string;
      readonly toolkit: "gmail" | "googlecalendar" | "googledrive";
    },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.connectIntegrationFromSettings({
      ...input,
      actor: {
        authSessionId: AuthSessionId.make(input.actor.authSessionId),
        userId: UserId.make(input.actor.userId),
      },
    });
  }

  /** Revoke one current Integration Connection. */
  async disconnectIntegrationFromSettings(
    agentId: string,
    input: {
      readonly actor: { readonly authSessionId: string; readonly userId: string };
      readonly toolkit: "gmail" | "googlecalendar" | "googledrive";
    },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.disconnectIntegrationFromSettings({
      ...input,
      actor: {
        authSessionId: AuthSessionId.make(input.actor.authSessionId),
        userId: UserId.make(input.actor.userId),
      },
    });
  }

  /** Commit one non-destructive personal Skill lifecycle change. */
  async changePersonalSkill(
    agentId: string,
    input: {
      readonly actor: { readonly decisionReference: string; readonly userId: string };
      readonly change: SkillChangeRequest;
    },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.changePersonalSkill({
      ...input,
      actor: { ...input.actor, userId: UserId.make(input.actor.userId) },
    });
  }

  /** Present the exact current personal Skill lineage for deletion. */
  async presentPersonalSkillDeletion(
    agentId: string,
    input: {
      readonly actor: { readonly decisionReference: string; readonly userId: string };
      readonly reference: string;
    },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.presentPersonalSkillDeletion({
      ...input,
      actor: { ...input.actor, userId: UserId.make(input.actor.userId) },
    });
  }

  /** Delete one exact personal Skill lineage after Approval. */
  async deletePersonalSkillFromSettings(
    agentId: string,
    input: {
      readonly actor: { readonly decisionReference: string; readonly userId: string };
      readonly reference: string;
      readonly request: SkillDeletionRequest;
    },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.deletePersonalSkillFromSettings({
      ...input,
      actor: { ...input.actor, userId: UserId.make(input.actor.userId) },
    });
  }

  /** List the authoritative user-owned facet registry. */
  listAgents(): ReadonlyArray<{ readonly className: string; readonly name: string }> {
    return this.listSubAgents(OsfoAgent).map(({ className, name }) => ({ className, name }));
  }

  /** Delete one user-owned facet and its SQLite state. */
  async deleteAgent(agentId: string): Promise<void> {
    await this.deleteSubAgent(OsfoAgent, agentId);
  }

  /** Fence new provider appends and wait for already-started provider work. */
  async quiesceAgentAccountDeletion(agentId: string, userId: string): Promise<void> {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return;
    const agent = await this.subAgent(OsfoAgent, agentId);
    await agent.quiesceAccountDeletion(userId);
  }

  async #agentForUser(encodedUserId: string) {
    const userId = await Effect.runPromise(Schema.decodeEffect(UserId)(encodedUserId));
    const route = await Effect.runPromise(
      Effect.scoped(
        AgentDirectory.Service.pipe(
          Effect.flatMap((directory) => directory.resolve(userId)),
          Effect.option,
          Effect.provide(directoryMessengerLayer(this.env)),
        ),
      ),
    );
    if (Option.isNone(route) || !this.hasSubAgent(OsfoAgent, route.value.agentId)) return null;
    return this.subAgent(OsfoAgent, route.value.agentId);
  }

  #resolveMessengerAddress = Effect.fn("OsfoDirectory.resolveMessengerAddress")(
    { self: this },
    function* (this: OsfoDirectory, address: typeof ChannelLinks.ChannelAddress.Type) {
      const channelLinks = yield* ChannelLinks.Service;
      const agentDirectory = yield* AgentDirectory.Service;
      const resolution = yield* channelLinks.resolveConversation(address).pipe(
        Effect.map(Option.some),
        Effect.catchTag("ChannelLinksUnavailable", () => Effect.succeed(Option.none())),
      );
      if (Option.isNone(resolution)) return { _tag: "Unavailable" as const };
      if (resolution.value._tag === "Unlinked") return resolution.value;
      const route = yield* agentDirectory.resolve(resolution.value.link.userId).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          AgentRouteNotFound: () => Effect.succeed(Option.none()),
          DbUnavailable: () => Effect.succeed(Option.none()),
        }),
      );
      if (Option.isNone(route) || !this.hasSubAgent(OsfoAgent, route.value.agentId)) {
        return { _tag: "Unavailable" as const };
      }
      return {
        _tag: "Linked" as const,
        agentId: route.value.agentId,
      } satisfies MessengerAddressResolution;
    },
  );
}

/**
 * Deterministically gate a directory messenger turn before any model or User
 * authority exists. Unlinked direct-message senders never land here: the
 * conversation resolver routes them to their Company Conversation facet.
 */
const replyToDirectoryGate = Effect.fn("OsfoDirectory.replyToMessenger")(function* (
  callback: StreamCallback,
  context: MessengerContext,
) {
  // Think hands messenger turns its serializable event snapshot, which carries
  // the author inside the message rather than at the context top level.
  const authorId = messengerAuthorId(context);
  const message = context.message;
  if (authorId === undefined || message === undefined) {
    yield* streamTextReply(
      callback,
      "channel-address-unreadable",
      "I could not read that message. Please try again.",
    );
    return;
  }
  if (!context.thread.isDirectMessage) {
    yield* streamTextReply(callback, message.id, `${GroupRefusalCopy.en}\n${GroupRefusalCopy.es}`);
    return;
  }
  const channelLinks = yield* ChannelLinks.Service;
  const resolved = yield* channelLinks
    .resolve(channelAddressOf(context.messengerId, authorId))
    .pipe(
      Effect.map(Option.some),
      Effect.catchTag("ChannelLinksUnavailable", () => Effect.succeed(Option.none())),
    );
  const linked = Option.isSome(resolved) && resolved.value !== null;
  if (linked) {
    yield* streamTextReply(
      callback,
      message.id,
      "This channel is linked, but I could not reach your Osfo Agent. Please try again.",
    );
    return;
  }
  yield* streamTextReply(callback, message.id, "Please send that message again.");
});

const directoryMessengerLayer = (env: Env & RuntimeSecrets) => {
  const config = loadConfig(env);
  const base = Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer);
  return Layer.merge(
    ChannelLinks.layerFromConfig(config),
    AgentDirectory.layerWithoutDependencies,
  ).pipe(Layer.provide(base));
};
