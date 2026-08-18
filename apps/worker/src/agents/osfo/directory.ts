import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { Think, type StreamCallback, type ThinkChannels } from "@cloudflare/think";
import type { MessengerContext } from "@cloudflare/think/messengers";
import type { UIMessage } from "ai";
import { Effect, Exit, Layer, Redacted } from "effect";

import * as Db from "../../db";
import { ChannelIdentity } from "../../domain";
import * as OnboardingCloudflare from "../../integrations/cloudflare/onboarding";
import * as ChannelBindingPostgres from "../../integrations/postgres/channel-binding";
import * as OnboardingPostgres from "../../integrations/postgres/onboarding";
import * as OnboardingLinks from "../../integrations/public/onboarding-links";
import {
  completeDeterministicTelegramReply,
  makeTelegramChannel,
  makeTelegramConversationResolver,
} from "../../integrations/telegram";
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

  /** Configure the shared Telegram webhook and its user-facet resolver. */
  override configureChannels(): ThinkChannels {
    const conversation = makeTelegramConversationResolver({
      agentClass: OsfoAgent,
      hasAgent: (agentId) => this.hasSubAgent(OsfoAgent, agentId),
      isAllowed: (authorId) => this.#telegramAllowedUserIds().has(authorId),
      resolveAgentId: (authorId) => this.#resolveTelegramAgentId(authorId),
    });
    return {
      telegram: makeTelegramChannel({
        conversation,
        secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        token: this.env.TELEGRAM_BOT_TOKEN,
        userName: this.env.TELEGRAM_BOT_USERNAME,
      }),
    };
  }

  /** Handle only deterministic Telegram outcomes that intentionally target the directory. */
  override async chatWithMessengerContext(
    _userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerContext,
  ): Promise<void> {
    const authorId = context.message?.author.userId ?? context.author?.userId;
    const message = context.message;
    if (authorId === undefined || message === undefined) {
      await this.#deliverTelegramNotice(
        context,
        "I could not read that message. Please try again.",
      );
      await completeDeterministicTelegramReply(callback);
      return;
    }
    if (!this.#telegramAllowedUserIds().has(authorId)) {
      await this.#deliverTelegramNotice(context, "This Telegram account is not authorized.");
      await completeDeterministicTelegramReply(callback);
      return;
    }

    const token = readTelegramEnrollmentToken(message.text);
    if (token !== null) {
      const enrolled = await Effect.runPromiseExit(
        this.#enrollTelegram(authorId, message.id, token),
      );
      await this.#deliverTelegramNotice(
        context,
        enrolled._tag === "Success"
          ? "Telegram is connected to your Osfo Agent."
          : "I could not connect Telegram. Open Osfo and create a new connection link.",
      );
      await completeDeterministicTelegramReply(callback);
      return;
    }

    const enrollmentUrl = new URL("/get-started", this.env.BETTER_AUTH_BASE_URL).href;
    await this.#deliverTelegramNotice(
      context,
      `Open ${enrollmentUrl} to connect Telegram to your Osfo Agent.`,
    );
    await completeDeterministicTelegramReply(callback);
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
    const binding = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* Db.database;
          return yield* ChannelBindingPostgres.resolveActiveAgentBinding(
            database,
            "telegram",
            ChannelIdentity.make(`telegram:${authorId}`),
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

  #telegramAllowedUserIds(): ReadonlySet<string> {
    return new Set(
      this.env.TELEGRAM_ALLOWED_USER_IDS.split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
  }

  #enrollTelegram(authorId: string, eventId: string, token: Onboarding.RegistrationToken) {
    const base = Layer.merge(Db.layer({ db: this.env.DB }), BrowserCrypto.layer);
    const dependencies = Layer.mergeAll(
      Registration.layerWithoutDependencies,
      OnboardingCloudflare.layer(this.env),
      OnboardingLinks.layer({
        enrollmentProvider: "telegram",
        officialWhatsAppNumber: this.env.WHATSAPP_PHONE_NUMBER,
        publicBaseUrl: new URL(this.env.BETTER_AUTH_BASE_URL),
        telegramBotUsername: this.env.TELEGRAM_BOT_USERNAME,
      }),
    ).pipe(Layer.provideMerge(base));
    const onboarding = Onboarding.layerWithoutDependencies.pipe(
      Layer.provide(OnboardingPostgres.layerWithoutDependencies),
      Layer.provide(dependencies),
    );
    return Effect.scoped(
      Effect.flatMap(Onboarding.Service, (service) =>
        service.enrollTelegram({
          channelIdentity: ChannelIdentity.make(`telegram:${authorId}`),
          eventId,
          token: Redacted.make(token),
        }),
      ).pipe(Effect.provide(onboarding)),
    );
  }

  #deliverTelegramNotice(context: MessengerContext, text: string): Promise<void> {
    return this.deliverNotice(text, {
      channel: "telegram",
      thread: context.thread.id,
    });
  }
}

const readTelegramEnrollmentToken = (text: string): Onboarding.RegistrationToken | null => {
  const match = /^\/start(?:@[A-Za-z0-9_]+)? ([0-9a-f]{64})$/u.exec(text.trim());
  return match?.[1] === undefined ? null : Onboarding.RegistrationToken.make(match[1]);
};
