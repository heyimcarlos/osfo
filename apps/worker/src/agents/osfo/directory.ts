import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { Think, type StreamCallback, type ThinkChannels } from "@cloudflare/think";
import type { MessengerContext } from "@cloudflare/think/messengers";
import type { UIMessage } from "ai";
import { Effect, Exit, Layer, Redacted } from "effect";

import { loadConfig, publicWebBaseUrl } from "../../config";
import * as Db from "../../db";
import { ChannelBindingId, ChannelIdentity } from "../../domain";
import * as OnboardingCloudflare from "../../integrations/cloudflare/onboarding";
import * as ChannelBindingPostgres from "../../integrations/postgres/channel-binding";
import * as OnboardingPostgres from "../../integrations/postgres/onboarding";
import * as OnboardingLinks from "../../integrations/public/onboarding-links";
import { makeTelegramChannel, makeTelegramConversationResolver } from "../../integrations/telegram";
import { makeWhatsAppChannel, makeWhatsAppConversationResolver } from "../../integrations/whatsapp";
import { invalidOsfoEnvironment, type RuntimeProbeResult } from "../../layers";
import type { RuntimeSecrets } from "../../runtime-secrets";
import * as Onboarding from "../../services/onboarding";
import * as Registration from "../../services/registration";
import { OsfoAgent } from "./agent";
import type { AgentInitializationEncoded } from "./db/store";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- Think hooks and RPC use Promise boundaries, messenger turns are application entry points, and Effect results use _tag. */

export { OSFO_DIRECTORY_NAME } from "./identity";

/** Root Agent that owns the registry of user-scoped Osfo Agent facets. */
export class OsfoDirectory extends Think<Env & RuntimeSecrets> {
  /** Keep the directory model dormant. User turns run only on child facets. */
  override getModel() {
    return "@cf/openai/gpt-oss-120b";
  }

  /** Configure the shared messenger webhooks and their user-facet resolvers. */
  override configureChannels(): ThinkChannels {
    const telegramConversation = makeTelegramConversationResolver({
      agentClass: OsfoAgent,
      hasAgent: (agentId) => this.hasSubAgent(OsfoAgent, agentId),
      isAllowed: (authorId) => this.#telegramAllowedUserIds().has(authorId),
      resolveAgentId: (authorId) => this.#resolveTelegramAgentId(authorId),
    });
    const whatsAppConversation = makeWhatsAppConversationResolver({
      agentClass: OsfoAgent,
      hasAgent: (agentId) => this.hasSubAgent(OsfoAgent, agentId),
      resolveAgentId: (authorId) => this.#resolveWhatsAppAgentId(authorId),
    });
    return {
      telegram: makeTelegramChannel({
        conversation: telegramConversation,
        secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        token: this.env.TELEGRAM_BOT_TOKEN,
        userName: this.env.TELEGRAM_BOT_USERNAME,
      }),
      whatsapp: makeWhatsAppChannel({
        accessToken: this.env.WHATSAPP_ACCESS_TOKEN,
        appSecret: this.env.WHATSAPP_APP_SECRET,
        conversation: whatsAppConversation,
        phoneNumberId: this.env.WHATSAPP_PHONE_NUMBER_ID,
        userName: this.env.WHATSAPP_BOT_USERNAME,
        verifyToken: this.env.WHATSAPP_VERIFY_TOKEN,
      }),
    };
  }

  /** Handle enrollment and temporary registration dialogue for unbound senders. */
  override async chatWithMessengerContext(
    _userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerContext,
  ): Promise<void> {
    if (context.provider === "whatsapp") {
      await this.#handleWhatsAppDirectoryTurn(callback, context);
      return;
    }
    const authorId = context.message?.author.userId ?? context.author?.userId;
    const message = context.message;
    if (authorId === undefined || message === undefined) {
      await streamReply(
        callback,
        "telegram-unreadable",
        "I could not read that message. Please try again.",
      );
      return;
    }
    if (!this.#telegramAllowedUserIds().has(authorId)) {
      await streamReply(callback, message.id, "This Telegram account is not authorized.");
      return;
    }

    const token = readTelegramEnrollmentToken(message.text);
    if (token !== null) {
      const enrolled = await Effect.runPromiseExit(
        this.#enrollChannel({
          channelIdentity: ChannelIdentity.make(`telegram:${authorId}`),
          eventId: message.id,
          provider: "telegram",
          token: Redacted.make(token),
        }),
      );
      await streamReply(
        callback,
        message.id,
        enrolled._tag === "Success"
          ? "Telegram is connected to your Osfo Agent."
          : "I could not connect Telegram. Open Osfo and create a new connection link.",
      );
      return;
    }

    await this.#registrationReply(callback, {
      channelIdentity: ChannelIdentity.make(`telegram:${authorId}`),
      eventId: message.id,
      locale: "en",
      message: message.text,
      provider: "telegram",
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

  /** Initialize one registered user-owned facet. */
  async initializeAgent(agentId: string, input: AgentInitializationEncoded) {
    const agent = await this.subAgent(OsfoAgent, agentId);
    const result = await agent.initialize(input);
    return { _tag: result._tag };
  }

  /** Commit one deterministic welcome to a registered user-owned facet. */
  async commitAgentWelcome(agentId: string, input: Parameters<OsfoAgent["commitWelcome"]>[0]) {
    const agent = await this.subAgent(OsfoAgent, agentId);
    const result = await agent.commitWelcome(input);
    if (result._tag !== "PersonalWelcomeCommitted") return { _tag: result._tag };
    const route = await this.#welcomeRoute(agentId, ChannelBindingId.make(input.channelBindingId));
    await this.deliverNotice(result.text, route);
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

  async #resolveTelegramAgentId(authorId: string): Promise<string | null> {
    return this.#resolveAgentId("telegram", ChannelIdentity.make(`telegram:${authorId}`));
  }

  async #resolveWhatsAppAgentId(authorId: string): Promise<string | null> {
    return this.#resolveAgentId("whatsapp", ChannelIdentity.make(authorId));
  }

  async #resolveAgentId(
    provider: Onboarding.ChannelProvider,
    channelIdentity: ChannelIdentity,
  ): Promise<string | null> {
    const binding = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* Db.database;
          return yield* ChannelBindingPostgres.resolveActiveAgentBinding(
            database,
            provider,
            channelIdentity,
          );
        }).pipe(Effect.provide(Db.layer({ db: this.env.DB }))),
      ),
    );
    if (
      Exit.isFailure(binding) ||
      binding.value === null ||
      !this.hasSubAgent(OsfoAgent, binding.value.agentId)
    ) {
      return null;
    }
    return binding.value.agentId;
  }

  async #welcomeRoute(
    agentId: string,
    channelBindingId: ChannelBindingId,
  ): Promise<{ readonly channel: "telegram" | "whatsapp"; readonly thread: string }> {
    const facts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* Db.database;
          const binding = yield* Effect.promise(() =>
            ChannelBindingPostgres.readBindingById(database, channelBindingId),
          );
          if (binding === null || binding.revokedAt !== null) return null;
          const owner = yield* ChannelBindingPostgres.resolveActiveAgentBinding(
            database,
            binding.provider,
            binding.channelIdentity,
          );
          return { binding, owner };
        }).pipe(Effect.provide(Db.layer({ db: this.env.DB }))),
      ),
    );
    if (
      facts === null ||
      facts.owner?.agentId !== agentId ||
      facts.owner.channelBindingId !== channelBindingId
    ) {
      throw new Error("The welcome Channel Binding is unavailable");
    }
    return {
      channel: facts.binding.provider,
      thread:
        facts.binding.provider === "telegram"
          ? facts.binding.channelIdentity
          : `whatsapp:${this.env.WHATSAPP_PHONE_NUMBER_ID}:${facts.binding.channelIdentity}`,
    };
  }

  async #handleWhatsAppDirectoryTurn(
    callback: StreamCallback,
    context: MessengerContext,
  ): Promise<void> {
    const authorId = context.message?.author.userId ?? context.author?.userId;
    const message = context.message;
    if (authorId === undefined || message === undefined) {
      await streamReply(
        callback,
        "whatsapp-unreadable",
        "I could not read that message. Please try again.",
      );
      return;
    }

    const token = readWhatsAppEnrollmentToken(message.text);
    if (token !== null) {
      const result = await Effect.runPromiseExit(
        this.#enrollChannel({
          channelIdentity: ChannelIdentity.make(authorId),
          eventId: message.id,
          provider: "whatsapp",
          token: Redacted.make(token),
        }),
      );
      await streamReply(
        callback,
        message.id,
        Exit.isSuccess(result)
          ? "WhatsApp is connected to your Osfo Agent."
          : "I could not complete WhatsApp setup. Open Osfo and create a new connection link.",
      );
      return;
    }

    await this.#registrationReply(callback, {
      channelIdentity: ChannelIdentity.make(authorId),
      eventId: message.id,
      invitedPhoneNumber: authorId,
      locale: "en",
      message: message.text,
      provider: "whatsapp",
    });
  }

  #telegramAllowedUserIds(): ReadonlySet<string> {
    return new Set(
      this.env.TELEGRAM_ALLOWED_USER_IDS.split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
  }

  #enrollChannel(input: Onboarding.ChannelEnrollment) {
    return this.#withOnboarding((service) => service.enrollChannel(input));
  }

  async #registrationReply(
    callback: StreamCallback,
    input: Onboarding.ChannelInvitationMessage,
  ): Promise<void> {
    const issued = await Effect.runPromiseExit(
      this.#withOnboarding((service) => service.issueChannelInvitation(input)).pipe(
        Effect.tapError((failure) =>
          Effect.logError("Channel-first invitation failed").pipe(
            Effect.annotateLogs({ failureTag: failure._tag, provider: input.provider }),
          ),
        ),
      ),
    );
    if (Exit.isFailure(issued)) {
      await streamReply(callback, input.eventId, "I could not complete setup. Please try again.");
      return;
    }

    const dialogue = this.env.REGISTRATION_DIALOGUE.getByName(issued.value.invitationId);
    const result = await dialogue.reply(
      {
        eventId: input.eventId,
        locale: input.locale,
        message: input.message,
        verifyUrl: issued.value.verifyUrl.href,
      },
      callback,
    );
    if (result._tag === "RegistrationDialogueUnavailable") {
      await streamReply(callback, input.eventId, "I could not complete setup. Please try again.");
    }
  }

  #withOnboarding<A, E>(operation: (service: Onboarding.Interface) => Effect.Effect<A, E>) {
    const base = Layer.merge(Db.layer({ db: this.env.DB }), BrowserCrypto.layer);
    const dependencies = Layer.mergeAll(
      Registration.layerWithoutDependencies,
      OnboardingCloudflare.layer(this.env),
      OnboardingLinks.layer({
        officialWhatsAppNumber: this.env.WHATSAPP_PUBLIC_PHONE_NUMBER,
        publicBaseUrl: publicWebBaseUrl(loadConfig(this.env).auth),
        telegramBotUsername: this.env.TELEGRAM_BOT_USERNAME,
      }),
    ).pipe(Layer.provideMerge(base));
    const onboarding = Onboarding.layerWithoutDependencies.pipe(
      Layer.provide(OnboardingPostgres.layerWithoutDependencies),
      Layer.provide(dependencies),
    );
    return Effect.scoped(
      Effect.flatMap(Onboarding.Service, operation).pipe(Effect.provide(onboarding)),
    );
  }
}

const streamReply = async (callback: StreamCallback, requestId: string, text: string) => {
  await callback.onStart({ requestId });
  await callback.onEvent(JSON.stringify({ delta: text, type: "text-delta" }));
  await callback.onDone();
};

const readTelegramEnrollmentToken = (text: string): Onboarding.RegistrationToken | null => {
  const match = /^\/start(?:@[A-Za-z0-9_]+)? ([0-9a-f]{64})$/u.exec(text.trim());
  return match?.[1] === undefined ? null : Onboarding.RegistrationToken.make(match[1]);
};

const readWhatsAppEnrollmentToken = (text: string): Onboarding.RegistrationToken | null => {
  const match = /^OSFO ENROLL ([0-9a-f]{64})$/u.exec(text.trim());
  return match?.[1] === undefined ? null : Onboarding.RegistrationToken.make(match[1]);
};
