import { BrowserCrypto } from "@effect/platform-browser";
import { Think, type StreamCallback, type TurnConfig, type TurnContext } from "@cloudflare/think";
import type { MessengerContext } from "@cloudflare/think/messengers";
import { tool, type ToolSet, type UIMessage } from "ai";
import { DateTime, Effect, Layer, Option, Schema } from "effect";

import { loadConfig } from "../../config";
import { Db } from "../../db";
import type { RuntimeSecrets } from "../../runtime-secrets";
import { ChannelLinks } from "../../services/channel-links";
import {
  ACCEPTANCE_TEARDOWN_MS,
  boundedTranscriptWindow,
  planTeardown,
  sanitizeCompanyMessage,
  TRANSCRIPT_WINDOW_MESSAGES,
  transcriptMessagesToPrune,
} from "./company-conversation";
import {
  type HeldInvite,
  type InvitePresenter,
  makeInvitePresenter,
  presentationAwareCallback,
} from "./company-invitation";
import { effectToolSchema } from "./effect-tool-schema";
import { channelAddressOf, messengerAuthorId } from "./channel-address";
import {
  finishStream,
  type MessengerDeliveryUnavailable,
  streamTextReply,
} from "./messenger-stream";
import { companyConversationSystemPrompt } from "./persona";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- The Company Agent owns Promise transactions and Layer composition; Effect results use _tag. */

/** Upper bound on model steps inside one company turn. */
const COMPANY_MAX_STEPS = 4;

/** Stable scheduler identity for the single teardown callback per conversation. */
const COMPANY_TEARDOWN_PAYLOAD = "company-conversation-expiry";

/** Name of the only capability the Company Conversation exposes to its model. */
const PRESENT_LINK_TOOL_NAME = "present_link";

const UNREADABLE_REPLY = "I could not read that message. Please try again.";
const LINKED_RACE_REPLY =
  "This channel is linked, but I could not reach your Osfo Agent. Please try again.";
const ATTEMPT_ENDED_REPLY = "That linking attempt has ended. Please send your message again.";
const AUTHORITY_UNAVAILABLE_REPLY =
  "I could not prepare your invite right now. Please ask me again in a moment.";
const DAILY_LIMIT_REPLY =
  "Osfo has reached its message limit for today here. Please come back tomorrow.";

const PresentLinkInput = Schema.Struct({});

/** Persisted lifecycle facts owned by one Company Conversation facet. */
const CompanyConversationState = Schema.Struct({
  addressAuthorId: Schema.String,
  addressChannelId: Schema.String,
  lastActivityAt: Schema.DateFromString,
});

const CompanyConversationOperation = Schema.Literals([
  "addressKey",
  "admitDailyTurn",
  "modelTurn",
  "pruneTranscript",
  "readTranscript",
  "scheduleExpiry",
]);

/** Safe failure raised by a Promise-only Company Conversation host operation. */
class CompanyConversationUnavailable extends Schema.TaggedError<CompanyConversationUnavailable>()(
  "CompanyConversationUnavailable",
  {
    message: Schema.String,
    operation: CompanyConversationOperation,
  },
) {}

/** Opaque routing identity for one address and one uninterrupted linking attempt. */
export const companyAddressKey = Effect.fn("CompanyAgent.addressKey")(function* (
  address: typeof ChannelLinks.ChannelAddress.Type,
  previousChannelLinkId: ChannelLinks.ChannelLinkId | null,
) {
  const attempt = previousChannelLinkId ?? "initial";
  const digest = yield* companyPromise("addressKey", () =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${address.channelId}\0${address.authorId}\0${attempt}`),
    ),
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `company-${hex}`;
});

/** Temporary, address-and-attempt-scoped Osfo conversation served before registration. */
export class CompanyAgent extends Think<Env & RuntimeSecrets> {
  override workspaceBash = false;
  override includeMcpTools = false;
  override storeMessages = false;
  override storeTools = false;
  override sendReasoning = false;
  override chatRecovery = false;
  override hydrationByteBudget = 128_000;
  override maxSteps = COMPANY_MAX_STEPS;

  #activePresenter: InvitePresenter | null = null;
  #heldInvite: HeldInvite | null = null;

  /** Serve the fixed company route; configuration may pin an alternate Workers AI slug. */
  override getModel() {
    return loadConfig(this.env).companyConversation.modelRoute;
  }

  /** Speak with the shared Osfo persona under the pre-registration contract. */
  override getSystemPrompt() {
    return companyConversationSystemPrompt();
  }

  /** Register the one presentation capability and no User-authority tools. */
  override getTools(): ToolSet {
    return {
      [PRESENT_LINK_TOOL_NAME]: tool({
        description:
          "Ask the system to attach this person's private registration link to your reply. Call it when they want to try Osfo, ask how to register, or hit something only a registered Osfo can do.",
        execute: () => {
          this.#activePresenter?.request();
          return { presented: true };
        },
        inputSchema: effectToolSchema(PresentLinkInput),
      }),
    };
  }

  /** Keep model input within the same bound enforced on durable history. */
  override beforeTurn(context: TurnContext): TurnConfig {
    return {
      activeTools: [PRESENT_LINK_TOOL_NAME],
      messages: boundedTranscriptWindow(context.messages, TRANSCRIPT_WINDOW_MESSAGES),
    };
  }

  /** Run one unlinked sender turn under the Company Conversation envelope. */
  override chatWithMessengerContext(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerContext,
  ): Promise<void> {
    return Effect.runPromise(
      Effect.scoped(
        this.#replyToMessenger(callback, context, userMessage).pipe(
          Effect.provide(companyConversationLayer(this.env)),
        ),
      ),
    );
  }

  /** Recheck acceptance and idle expiry on the facet-owned schedule. */
  expireCompanyConversation(): Promise<void> {
    return Effect.runPromise(
      Effect.scoped(
        this.#expireCompanyConversation().pipe(Effect.provide(companyConversationLayer(this.env))),
      ),
    );
  }

  #replyToMessenger = Effect.fn("CompanyAgent.replyToMessenger")(
    { self: this },
    function* (
      this: CompanyAgent,
      callback: StreamCallback,
      context: MessengerContext,
      userMessage: string | UIMessage,
    ): Effect.fn.Return<
      void,
      CompanyConversationUnavailable | MessengerDeliveryUnavailable,
      ChannelLinks.Service
    > {
      const authorId = messengerAuthorId(context);
      const message = context.message;
      if (authorId === undefined || message === undefined) {
        yield* streamTextReply(callback, "channel-address-unreadable", UNREADABLE_REPLY);
        return;
      }

      // Think atomically deduplicates provider events with its durable
      // idempotency key before resolving and invoking this facet.

      const address = channelAddressOf(context.messengerId, authorId);
      const channelLinks = yield* ChannelLinks.Service;
      const current = yield* channelLinks.resolveConversation(address).pipe(
        Effect.map(Option.some),
        Effect.catchTag("ChannelLinksUnavailable", () => Effect.succeed(Option.none())),
      );
      if (Option.isNone(current)) {
        yield* streamTextReply(callback, message.id, AUTHORITY_UNAVAILABLE_REPLY);
        return;
      }
      if (current.value._tag === "Linked") {
        this.#heldInvite = null;
        yield* streamTextReply(callback, message.id, LINKED_RACE_REPLY);
        this.#destroy();
        return;
      }

      const expectedKey = yield* companyAddressKey(address, current.value.previousChannelLinkId);
      if (expectedKey !== this.name) {
        this.#heldInvite = null;
        yield* streamTextReply(callback, message.id, ATTEMPT_ENDED_REPLY);
        this.#destroy();
        return;
      }

      yield* this.#recordActivity(context);
      if (!(yield* this.#admitDailyTurn(loadConfig(this.env).companyConversation.dailyTurnLimit))) {
        yield* streamTextReply(callback, message.id, DAILY_LIMIT_REPLY);
        return;
      }

      const presenter = makeInvitePresenter({
        address,
        channelLinks,
        previousChannelLinkId: current.value.previousChannelLinkId,
        readHeld: () => this.#heldInvite,
        requestId: message.providerMessageId ?? message.id,
        writeHeld: (held) => {
          this.#heldInvite = held;
        },
      });
      const managedCallback = yield* presentationAwareCallback(callback, presenter);
      const sanitizedMessage = sanitizeCompanyMessage(userMessage);

      yield* this.#runManagedTurn(sanitizedMessage, managedCallback, context, presenter).pipe(
        Effect.catchIf(
          () => presenter.wasRequested(),
          () => presenter.flush(callback, true).pipe(Effect.andThen(finishStream(callback))),
        ),
      );
      if (presenter.wasRequested()) yield* presenter.flush(callback, true);
    },
  );

  #runManagedTurn(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerContext,
    presenter: InvitePresenter,
  ): Effect.Effect<void, CompanyConversationUnavailable> {
    this.#activePresenter = presenter;
    return companyPromise("modelTurn", () =>
      super.chatWithMessengerContext(userMessage, callback, context, {}),
    ).pipe(
      Effect.ensuring(
        Effect.all([
          Effect.sync(() => {
            this.#activePresenter = null;
          }),
          this.#pruneTranscript().pipe(Effect.orDie),
        ]),
      ),
    );
  }

  #recordActivity = Effect.fn("CompanyAgent.recordActivity")(
    { self: this },
    function* (this: CompanyAgent, context: MessengerContext) {
      const authorId = messengerAuthorId(context);
      if (authorId === undefined) return;
      const now = yield* DateTime.now;
      const lastActivityAt = DateTime.toDateUtc(now);
      this.configure({
        addressAuthorId: authorId,
        addressChannelId: context.messengerId,
        lastActivityAt: lastActivityAt.toISOString(),
      });
      const acceptanceDeadline = DateTime.toDateUtc(
        DateTime.add(now, { milliseconds: ACCEPTANCE_TEARDOWN_MS }),
      );
      yield* companyPromise("scheduleExpiry", () =>
        this.schedule(acceptanceDeadline, "expireCompanyConversation", COMPANY_TEARDOWN_PAYLOAD, {
          idempotent: true,
        }),
      );
    },
  );

  #admitDailyTurn = Effect.fn("CompanyAgent.admitDailyTurn")(
    { self: this },
    function* (this: CompanyAgent, limit: number | null) {
      if (limit === null) return true;
      const today = DateTime.toDateUtc(yield* DateTime.now);
      const key = dailyTurnKey(today);
      return yield* companyPromise("admitDailyTurn", () =>
        this.ctx.storage.transaction(async (transaction) => {
          const current = (await transaction.get<number>(key)) ?? 0;
          if (current >= limit) return false;
          await transaction.put(key, current + 1);
          return true;
        }),
      );
    },
  );

  #pruneTranscript = Effect.fn("CompanyAgent.pruneTranscript")(
    { self: this },
    function* (this: CompanyAgent) {
      const history = yield* companyPromise("readTranscript", () => this.session.getHistory());
      const messageIds = transcriptMessagesToPrune(history, TRANSCRIPT_WINDOW_MESSAGES);
      if (messageIds.length === 0) return;
      yield* companyPromise("pruneTranscript", () => this.session.deleteMessages(messageIds));
    },
  );

  #expireCompanyConversation = Effect.fn("CompanyAgent.expireConversation")(
    { self: this },
    function* (this: CompanyAgent) {
      const stored = this.getConfig<unknown>();
      const state =
        stored === undefined || stored === null
          ? Option.none()
          : Schema.decodeUnknownOption(CompanyConversationState)(stored);
      if (Option.isNone(state)) {
        this.#destroy();
        return;
      }

      const channelLinks = yield* ChannelLinks.Service;
      const linked = yield* channelLinks
        .resolve(channelAddressOf(state.value.addressChannelId, state.value.addressAuthorId))
        .pipe(
          Effect.map((link) => link !== null),
          Effect.catchTag("ChannelLinksUnavailable", () => Effect.succeed(null)),
        );
      const decision = planTeardown({
        lastActivityAt: state.value.lastActivityAt,
        linked,
        now: DateTime.toDateUtc(yield* DateTime.now),
      });
      if (decision._tag === "Destroy") {
        this.#destroy();
        return;
      }
      yield* companyPromise("scheduleExpiry", () =>
        this.schedule(decision.at, "expireCompanyConversation", COMPANY_TEARDOWN_PAYLOAD, {
          idempotent: true,
        }),
      );
    },
  );

  #destroy(): void {
    this.destroy().catch(() => undefined);
  }
}

const dailyTurnKey = (date: Date) => `osfo-company-turns:${date.toISOString().slice(0, 10)}`;

const companyPromise = <A>(
  operation: typeof CompanyConversationOperation.Type,
  run: () => A | PromiseLike<A>,
): Effect.Effect<A, CompanyConversationUnavailable> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: () =>
      new CompanyConversationUnavailable({
        message: `Company Conversation ${operation} failed`,
        operation,
      }),
  }).pipe(Effect.withSpan(`CompanyAgent.${operation}`));

const companyConversationLayer = (env: Env & RuntimeSecrets) => {
  const base = Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer);
  return ChannelLinks.layerFromConfig(loadConfig(env)).pipe(Layer.provide(base));
};
