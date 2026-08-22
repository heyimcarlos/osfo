import { BrowserCrypto } from "@effect/platform-browser";
import { Think, type StreamCallback, type TurnConfig, type TurnContext } from "@cloudflare/think";
import type { MessengerContext } from "@cloudflare/think/messengers";
import { tool, type ToolSet, type UIMessage } from "ai";
import { Clock, type Context, DateTime, Effect, Exit, Layer, Option, Schema } from "effect";

import { loadConfig } from "../../config";
import { Db } from "../../db";
import type { RuntimeSecrets } from "../../runtime-secrets";
import { ChannelLinks } from "../../services/channel-links";
import { effectToolSchema } from "./effect-tool-schema";
import { channelAddressOf, messengerAuthorId } from "./channel-address";
import { companyConversationSystemPrompt } from "./persona";

/* oxlint-disable effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- The Company Agent is the Layer composition root, and Effect results use _tag. */

/** Maximum delay between checks for Channel Link acceptance. */
const ACCEPTANCE_TEARDOWN_MS = 6 * 60 * 60 * 1_000;

/** Maximum idle lifetime of one Company Conversation. */
const IDLE_TEARDOWN_MS = 24 * 60 * 60 * 1_000;

/** Retry delay when Channel Link authority cannot be read at teardown time. */
const TEARDOWN_UNCERTAIN_RETRY_MS = 30 * 60 * 1_000;

/** Model-visible messages kept at full fidelity in one company turn. */
const TRANSCRIPT_WINDOW_MESSAGES = 12;

/** Upper bound on model steps inside one company turn. */
const COMPANY_MAX_STEPS = 4;

/** Stable scheduler identity for the single teardown callback per conversation. */
const COMPANY_TEARDOWN_PAYLOAD = "company-conversation-expiry";

/** Name of the only capability the Company Conversation exposes to its model. */
export const PRESENT_LINK_TOOL_NAME = "present_link";

const PresentLinkInput = Schema.Struct({});
const StreamTextDelta = Schema.fromJsonString(
  Schema.Struct({ delta: Schema.String, type: Schema.Literals(["text-delta"]) }),
);

const UNREADABLE_REPLY = "I could not read that message. Please try again.";
const LINKED_RACE_REPLY =
  "This channel is linked, but I could not reach your Osfo Agent. Please try again.";
const INVITE_PREPARATION_REPLY =
  "I could not prepare your invite right now. Please ask me again in a moment.";
const DAILY_LIMIT_REPLY =
  "Osfo has reached its message limit for today here. Please come back tomorrow.";

type ReceiptStatus = "pending" | "completed";

/** Persisted lifecycle facts owned by one Company Conversation facet. */
const CompanyConversationState = Schema.Struct({
  addressAuthorId: Schema.String,
  addressChannelId: Schema.String,
  lastActivityAt: Schema.DateFromString,
});

const CompanyConversationOperation = Schema.Literals([
  "addressKey",
  "modelTurn",
  "readDailyTurns",
  "readReceipt",
  "scheduleExpiry",
  "streamDone",
  "streamError",
  "streamEvent",
  "streamInterrupted",
  "streamStart",
  "writeDailyTurns",
  "writeReceipt",
]);

/** Safe failure raised by a Promise-only Company Conversation host operation. */
export class CompanyConversationUnavailable extends Schema.TaggedError<CompanyConversationUnavailable>()(
  "CompanyConversationUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: CompanyConversationOperation,
  },
) {}

type TeardownDecision = { readonly _tag: "Destroy" } | { readonly _tag: "Wait"; readonly at: Date };

/**
 * Decide the next Company Conversation teardown wakeup. A linked address is
 * destroyed within hours of acceptance; an idle address within a day; an
 * unreadable authority never destroys on uncertainty.
 */
export const planTeardown = (input: {
  readonly lastActivityAt: Date;
  readonly linked: boolean | null;
  readonly now: Date;
}): TeardownDecision => {
  if (input.linked === true) return { _tag: "Destroy" };
  if (input.linked === null || isNaN(input.lastActivityAt.getTime())) {
    // oxlint-disable-next-line effecttsgo/global-date -- Think schedules use JavaScript Date values.
    return { _tag: "Wait", at: new Date(input.now.getTime() + TEARDOWN_UNCERTAIN_RETRY_MS) };
  }
  const idleMs = input.now.getTime() - input.lastActivityAt.getTime();
  if (idleMs >= IDLE_TEARDOWN_MS) return { _tag: "Destroy" };
  const acceptanceCheckNumber = Math.max(
    1,
    Math.floor(Math.max(0, idleMs) / ACCEPTANCE_TEARDOWN_MS) + 1,
  );
  const acceptanceCheckAt =
    input.lastActivityAt.getTime() + acceptanceCheckNumber * ACCEPTANCE_TEARDOWN_MS;
  const idleDeadline = input.lastActivityAt.getTime() + IDLE_TEARDOWN_MS;
  // oxlint-disable-next-line effecttsgo/global-date -- Think schedules use JavaScript Date values.
  const at = new Date(Math.min(acceptanceCheckAt, idleDeadline));
  return { _tag: "Wait", at };
};

/** Bound a model turn to the most recent window that starts on a user boundary. */
export const boundedTranscriptWindow = <T extends { readonly role: string }>(
  messages: ReadonlyArray<T>,
  keep: number,
): Array<T> => {
  if (messages.length <= keep) return [...messages];
  const earliest = messages.length - keep;
  const firstUserAtOrAfter = (start: number): number => {
    for (let index = start; index < messages.length; index += 1) {
      if (messages[index]?.role === "user") return index;
    }
    return start;
  };
  return messages.slice(firstUserAtOrAfter(earliest));
};

/**
 * Opaque deterministic routing identity for one Channel Address. The key is
 * routing identity only; it grants no authority and reverses to no address.
 */
export const companyAddressKey = Effect.fn("CompanyAgent.addressKey")(function* (
  messengerId: string,
  authorId: string,
) {
  const digest = yield* companyPromise("addressKey", () =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${messengerId}:${authorId}`)),
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `company-${hex}`;
});

/** Transient holder of the invite presentation capability for one turn. */
export interface InvitePresenter {
  readonly request: () => void;
  readonly wasRequested: () => boolean;
  readonly flush: (
    callback: StreamCallback,
    ensureStart: boolean,
  ) => Effect.Effect<void, CompanyConversationUnavailable>;
}

interface HeldInvite {
  readonly expiresAtMs: number;
  readonly url: URL;
}

/**
 * Hold-and-present rule for the current linking attempt. The verification URL
 * lives only in activation memory through `readHeld`/`writeHeld`: resend while
 * unexpired, mint once through ensure otherwise, and expose it only through the
 * delivery callback, never the prompt, transcript, logs, or errors.
 */
export const makeInvitePresenter = (dependencies: {
  readonly ensure: (
    address: typeof ChannelLinks.ChannelAddress.Type,
  ) => Effect.Effect<ChannelLinks.EnsureResult, ChannelLinks.ChannelLinksUnavailable>;
  readonly requestId: string;
  readonly address: typeof ChannelLinks.ChannelAddress.Type;
  readonly readHeld: () => HeldInvite | null;
  readonly writeHeld: (held: HeldInvite | null) => void;
}): InvitePresenter => {
  let requested = false;
  const resolveLine = Effect.fn("CompanyAgent.resolveInviteLine")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const existing = dependencies.readHeld();
    if (existing !== null && existing.expiresAtMs > nowMs) return existing.url.href;
    const ensured = yield* Effect.exit(dependencies.ensure(dependencies.address));
    if (Exit.isSuccess(ensured)) {
      if (ensured.value._tag === "Invited") {
        dependencies.writeHeld({
          expiresAtMs: ensured.value.expiresAt.getTime(),
          url: ensured.value.verificationUrl,
        });
        return ensured.value.verificationUrl.href;
      }
      dependencies.writeHeld(null);
      return LINKED_RACE_REPLY;
    }
    return INVITE_PREPARATION_REPLY;
  });
  const flush = Effect.fn("CompanyAgent.flushInvite")(function* (
    callback: StreamCallback,
    ensureStart: boolean,
  ) {
    if (!requested) return;
    requested = false;
    const line = yield* resolveLine();
    if (ensureStart) {
      yield* companyPromise("streamStart", () =>
        callback.onStart({ requestId: dependencies.requestId }),
      );
    }
    yield* companyPromise("streamEvent", () => callback.onEvent(encodeTextDelta(`\n${line}`)));
  });
  return {
    request: () => {
      requested = true;
    },
    wasRequested: () => requested,
    flush,
  };
};

/**
 * Wrap the live delivery surface so a presentation request registered mid-turn
 * still receives its deterministic link line when the model finishes, fails,
 * or stalls. A swallowed error keeps the streamed reply plus the link instead
 * of an apology; without a pending request every signal forwards unchanged.
 */
export const presentationAwareCallback = Effect.fn("CompanyAgent.presentationAwareCallback")(
  function* (real: StreamCallback, presenter: InvitePresenter): Effect.fn.Return<StreamCallback> {
    const context: Context.Context<never> = yield* Effect.context();
    const runPromise = Effect.runPromiseWith(context);
    let started = false;
    const flushIfRequested = () => presenter.flush(real, !started);
    return {
      onStart: (event) => {
        started = true;
        return runPromise(companyPromise("streamStart", () => real.onStart(event)));
      },
      onEvent: (json) => runPromise(companyPromise("streamEvent", () => real.onEvent(json))),
      onDone: () =>
        runPromise(
          flushIfRequested().pipe(
            Effect.andThen(companyPromise("streamDone", () => real.onDone())),
          ),
        ),
      onError: (error) =>
        runPromise(
          presenter.wasRequested()
            ? flushIfRequested().pipe(
                Effect.andThen(companyPromise("streamDone", () => real.onDone())),
              )
            : companyPromise("streamError", () => real.onError(error)),
        ),
      onInterrupted: () =>
        runPromise(
          flushIfRequested().pipe(
            Effect.andThen(
              real.onInterrupted === undefined
                ? Effect.void
                : companyPromise("streamInterrupted", () => real.onInterrupted?.()),
            ),
          ),
        ),
    };
  },
);

/** One delegated managed turn on the Company Conversation facet. */
export interface CompanyModelTurn {
  readonly callback: StreamCallback;
  readonly presenter: InvitePresenter;
  readonly userMessage: string | UIMessage;
}

/** Dependencies for one unlinked-sender messenger turn on a company facet. */
export interface CompanyMessengerTurnDependencies {
  readonly dailyTurnLimit: number | null;
  readonly recordActivity: Effect.Effect<void, CompanyConversationUnavailable>;
  readonly readHeld: () => HeldInvite | null;
  readonly readReceipt: (
    eventId: string,
  ) => Effect.Effect<ReceiptStatus | null, CompanyConversationUnavailable>;
  readonly recordTurn: Effect.Effect<void, CompanyConversationUnavailable>;
  readonly runModelTurn: (
    turn: CompanyModelTurn,
  ) => Effect.Effect<void, CompanyConversationUnavailable>;
  readonly turnsToday: Effect.Effect<number, CompanyConversationUnavailable>;
  readonly writeHeld: (held: HeldInvite | null) => void;
  readonly writeReceipt: (
    eventId: string,
    status: ReceiptStatus,
  ) => Effect.Effect<void, CompanyConversationUnavailable>;
}

/**
 * Orchestrate one unlinked direct-message sender turn: collapse duplicate
 * events, enforce the optional daily ceiling, run exactly one bounded model
 * turn, append the deterministic link line after it, and settle receipts.
 */
export const replyToCompanyMessenger = Effect.fn("CompanyAgent.replyToMessenger")(function* (
  callback: StreamCallback,
  context: MessengerContext,
  userMessage: string | UIMessage,
  dependencies: CompanyMessengerTurnDependencies,
) {
  const authorId = messengerAuthorId(context);
  const message = context.message;
  if (authorId === undefined || message === undefined) {
    yield* streamReply(callback, "channel-address-unreadable", UNREADABLE_REPLY);
    return;
  }
  const eventId = message.providerMessageId ?? message.id;
  if ((yield* dependencies.readReceipt(eventId)) !== null) return;
  yield* dependencies.recordActivity;

  if (
    dependencies.dailyTurnLimit !== null &&
    (yield* dependencies.turnsToday) >= dependencies.dailyTurnLimit
  ) {
    yield* dependencies.writeReceipt(eventId, "completed");
    yield* streamReply(callback, eventId, DAILY_LIMIT_REPLY);
    return;
  }

  const channelLinks = yield* ChannelLinks.Service;
  const address = channelAddressOf(context.messengerId, authorId);
  const presenter = makeInvitePresenter({
    address,
    ensure: (presentedAddress) => channelLinks.ensure(presentedAddress),
    readHeld: dependencies.readHeld,
    requestId: eventId,
    writeHeld: dependencies.writeHeld,
  });
  const managedCallback = yield* presentationAwareCallback(callback, presenter);

  yield* dependencies.writeReceipt(eventId, "pending");
  yield* dependencies.runModelTurn({ callback: managedCallback, presenter, userMessage }).pipe(
    Effect.catch((failure) => {
      // The turn died below the terminal callbacks. If the model already
      // asked for the link, the promised line still ships and delivery
      // completes. Otherwise the failure reaches the channel error policy.
      if (!presenter.wasRequested()) {
        return dependencies
          .writeReceipt(eventId, "completed")
          .pipe(Effect.andThen(Effect.fail(failure)));
      }
      return presenter
        .flush(callback, true)
        .pipe(Effect.andThen(companyPromise("streamDone", () => callback.onDone())));
    }),
  );
  if (presenter.wasRequested()) yield* presenter.flush(callback, true);
  yield* dependencies.writeReceipt(eventId, "completed");
  yield* dependencies.recordTurn;
});

/** Temporary, address-keyed Osfo conversation served before registration. */
export class CompanyAgent extends Think<Env & RuntimeSecrets> {
  /** Keep shell execution unavailable on the unprivileged partition. */
  override workspaceBash = false;

  /** Do not expose connected MCP catalogs to anonymous senders. */
  override includeMcpTools = false;

  /** Do not attach prompts or responses to telemetry spans. */
  override storeMessages = false;

  /** Do not attach tool inputs or outputs to telemetry spans. */
  override storeTools = false;

  /** Do not stream hidden model reasoning to a channel. */
  override sendReasoning = false;

  /** Never replay an interrupted anonymous turn; the link line stays deterministic. */
  override chatRecovery = false;

  /** Bound wake-time memory for the small transcript window. */
  override hydrationByteBudget = 128_000;

  /** One presentation round trip plus the final reply fits in four steps. */
  override maxSteps = COMPANY_MAX_STEPS;

  #activePresenter: InvitePresenter | null = null;
  /**
   * Activation-memory hold of the URL this attempt already delivered. It dies
   * with the isolate by design: invite tokens persist only as hashes, so a
   * restart simply re-mints on the next presentation request.
   */
  #heldInvite: HeldInvite | null = null;

  /** Serve the fixed company route; configuration may pin an alternate Workers AI slug. */
  override getModel() {
    return loadConfig(this.env).companyConversation.modelRoute;
  }

  /** Speak with the shared Osfo persona under the pre-registration contract. */
  override getSystemPrompt() {
    return companyConversationSystemPrompt();
  }

  /** Register the single presentation capability; nothing else is callable. */
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

  /** Keep the transcript window bounded and the tool surface presentation-only. */
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
    const config = loadConfig(this.env);
    return Effect.runPromise(
      Effect.scoped(
        replyToCompanyMessenger(callback, context, userMessage, {
          dailyTurnLimit: config.companyConversation.dailyTurnLimit,
          recordActivity: this.#recordActivity(context),
          readHeld: () => this.#heldInvite,
          readReceipt: (eventId) =>
            companyPromise("readReceipt", () =>
              this.ctx.storage
                .get<ReceiptStatus>(receiptKey(eventId))
                .then((receipt) => receipt ?? null),
            ),
          recordTurn: this.#recordDailyTurn(),
          runModelTurn: (turn) =>
            companyPromise("modelTurn", () => this.#runManagedTurn(turn, context)),
          turnsToday: this.#dailyTurnCount(),
          writeHeld: (held) => {
            this.#heldInvite = held;
          },
          writeReceipt: (eventId, status) =>
            companyPromise("writeReceipt", () => this.ctx.storage.put(receiptKey(eventId), status)),
        }).pipe(Effect.provide(companyConversationLayer(this.env))),
      ),
    );
  }

  /**
   * Teardown wakeup scheduled after every turn. Destroys the facet once its
   * address is linked or its idle lifetime elapsed; otherwise chains the next
   * deadline. One stable idempotency payload prevents turns from accumulating
   * redundant lifecycle callbacks; an earlier callback simply re-reads the
   * latest activity and schedules the next required check.
   */
  expireCompanyConversation(): Promise<void> {
    return Effect.runPromise(
      Effect.scoped(
        this.#expireCompanyConversation().pipe(Effect.provide(companyConversationLayer(this.env))),
      ),
    );
  }

  #runManagedTurn(turn: CompanyModelTurn, context: MessengerContext): Promise<void> {
    this.#activePresenter = turn.presenter;
    return super
      .chatWithMessengerContext(turn.userMessage, turn.callback, context, {})
      .finally(() => {
        this.#activePresenter = null;
      });
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

  #dailyTurnCount = Effect.fn("CompanyAgent.dailyTurnCount")(
    { self: this },
    function* (this: CompanyAgent) {
      const today = DateTime.toDateUtc(yield* DateTime.now);
      const count = yield* companyPromise("readDailyTurns", () =>
        this.ctx.storage.get<number>(dailyTurnKey(today)),
      );
      return count ?? 0;
    },
  );

  #recordDailyTurn = Effect.fn("CompanyAgent.recordDailyTurn")(
    { self: this },
    function* (this: CompanyAgent) {
      const today = DateTime.toDateUtc(yield* DateTime.now);
      const key = dailyTurnKey(today);
      const current = yield* companyPromise("readDailyTurns", () =>
        this.ctx.storage.get<number>(key),
      );
      yield* companyPromise("writeDailyTurns", () => this.ctx.storage.put(key, (current ?? 0) + 1));
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
      const resolved = yield* Effect.exit(
        channelLinks.resolve(
          channelAddressOf(state.value.addressChannelId, state.value.addressAuthorId),
        ),
      );
      const linked = Exit.isSuccess(resolved) ? resolved.value !== null : null;
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
    // Facet destruction delegates to the parent and aborts this isolate; the
    // durable condemned marker finishes teardown on a later wake if needed.
    this.destroy().catch(() => undefined);
  }
}

const receiptKey = (eventId: string) => `osfo-company-receipt:${eventId}`;

const dailyTurnKey = (date: Date) => `osfo-company-turns:${date.toISOString().slice(0, 10)}`;

const streamReply = Effect.fn("CompanyAgent.streamReply")(function* (
  callback: StreamCallback,
  requestId: string,
  text: string,
) {
  yield* companyPromise("streamStart", () => callback.onStart({ requestId }));
  yield* companyPromise("streamEvent", () => callback.onEvent(encodeTextDelta(text)));
  yield* companyPromise("streamDone", () => callback.onDone());
});

const companyPromise = <A>(
  operation: typeof CompanyConversationOperation.Type,
  run: () => A | PromiseLike<A>,
): Effect.Effect<A, CompanyConversationUnavailable> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) =>
      new CompanyConversationUnavailable({
        cause,
        message: `Company Conversation ${operation} failed`,
        operation,
      }),
  }).pipe(Effect.withSpan(`CompanyAgent.${operation}`));

const encodeTextDelta = (delta: string) =>
  Schema.encodeSync(StreamTextDelta)({ delta, type: "text-delta" });

const companyConversationLayer = (env: Env & RuntimeSecrets) => {
  const base = Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer);
  return ChannelLinks.layerFromConfig(loadConfig(env)).pipe(Layer.provide(base));
};
