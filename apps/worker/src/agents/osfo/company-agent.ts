import { BrowserCrypto } from "@effect/platform-browser";
import { Think, type StreamCallback, type TurnConfig, type TurnContext } from "@cloudflare/think";
import type { MessengerContext } from "@cloudflare/think/messengers";
import { tool, type ToolSet, type UIMessage } from "ai";
import { Effect, Exit, Layer, Option, Schema } from "effect";

import { loadConfig } from "../../config";
import { Db } from "../../db";
import type { RuntimeSecrets } from "../../runtime-secrets";
import { ChannelLinks } from "../../services/channel-links";
import { effectToolSchema } from "./effect-tool-schema";
import { channelAddressOf, messengerAuthorId } from "./channel-address";
import { companyConversationSystemPrompt } from "./persona";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- Cloudflare Agent RPC and messenger turns are Promise boundaries, the Agents SDK schedule and storage contracts use JavaScript Dates, and Effect results use _tag. */

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
export const companyAddressKey = async (messengerId: string, authorId: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${messengerId}:${authorId}`),
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `company-${hex}`;
};

/** Transient holder of the invite presentation capability for one turn. */
export interface InvitePresenter {
  readonly request: () => void;
  readonly wasRequested: () => boolean;
  readonly flush: (callback: StreamCallback, ensureStart: boolean) => Promise<void>;
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
  ) => Promise<Exit.Exit<ChannelLinks.EnsureResult, unknown>>;
  readonly requestId: string;
  readonly address: typeof ChannelLinks.ChannelAddress.Type;
  readonly readHeld: () => HeldInvite | null;
  readonly writeHeld: (held: HeldInvite | null) => void;
}): InvitePresenter => {
  let requested = false;
  const resolveLine = async (): Promise<string> => {
    const nowMs = Date.now();
    const existing = dependencies.readHeld();
    if (existing !== null && existing.expiresAtMs > nowMs) return existing.url.href;
    const ensured = await dependencies.ensure(dependencies.address);
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
  };
  return {
    request: () => {
      requested = true;
    },
    wasRequested: () => requested,
    flush: async (callback, ensureStart) => {
      if (!requested) return;
      requested = false;
      const line = await resolveLine();
      if (ensureStart) await callback.onStart({ requestId: dependencies.requestId });
      await callback.onEvent(JSON.stringify({ delta: `\n${line}`, type: "text-delta" }));
    },
  };
};

/**
 * Wrap the live delivery surface so a presentation request registered mid-turn
 * still receives its deterministic link line when the model finishes, fails,
 * or stalls. A swallowed error keeps the streamed reply plus the link instead
 * of an apology; without a pending request every signal forwards unchanged.
 */
export const presentationAwareCallback = (
  real: StreamCallback,
  presenter: InvitePresenter,
): StreamCallback => {
  let started = false;
  const flushIfRequested = () => presenter.flush(real, !started);
  return {
    onStart: (event) => {
      started = true;
      return real.onStart(event);
    },
    onEvent: (json) => real.onEvent(json),
    onDone: async () => {
      await flushIfRequested();
      await real.onDone();
    },
    onError: async (error) => {
      if (presenter.wasRequested()) {
        await flushIfRequested();
        await real.onDone();
        return;
      }
      await real.onError(error);
    },
    onInterrupted: async () => {
      await flushIfRequested();
      await real.onInterrupted?.();
    },
  };
};

/** One delegated managed turn on the Company Conversation facet. */
export interface CompanyModelTurn {
  readonly callback: StreamCallback;
  readonly presenter: InvitePresenter;
  readonly userMessage: string | UIMessage;
}

/** Dependencies for one unlinked-sender messenger turn on a company facet. */
export interface CompanyMessengerTurnDependencies {
  readonly dailyTurnLimit: number | null;
  readonly ensure: (
    address: typeof ChannelLinks.ChannelAddress.Type,
  ) => Promise<Exit.Exit<ChannelLinks.EnsureResult, unknown>>;
  readonly recordActivity: () => Promise<void>;
  readonly readHeld: () => HeldInvite | null;
  readonly readReceipt: (eventId: string) => Promise<ReceiptStatus | null>;
  readonly recordTurn: () => Promise<void>;
  readonly runModelTurn: (turn: CompanyModelTurn) => Promise<void>;
  readonly turnsToday: () => Promise<number>;
  readonly writeHeld: (held: HeldInvite | null) => void;
  readonly writeReceipt: (eventId: string, status: ReceiptStatus) => Promise<void>;
}

/**
 * Orchestrate one unlinked direct-message sender turn: collapse duplicate
 * events, enforce the optional daily ceiling, run exactly one bounded model
 * turn, append the deterministic link line after it, and settle receipts.
 */
export const replyToCompanyMessenger = async (
  callback: StreamCallback,
  context: MessengerContext,
  userMessage: string | UIMessage,
  dependencies: CompanyMessengerTurnDependencies,
): Promise<void> => {
  const authorId = messengerAuthorId(context);
  const message = context.message;
  if (authorId === undefined || message === undefined) {
    await streamReply(callback, "channel-address-unreadable", UNREADABLE_REPLY);
    return;
  }
  const eventId = message.providerMessageId ?? message.id;
  if ((await dependencies.readReceipt(eventId)) !== null) return;
  await dependencies.recordActivity();

  if (
    dependencies.dailyTurnLimit !== null &&
    (await dependencies.turnsToday()) >= dependencies.dailyTurnLimit
  ) {
    await dependencies.writeReceipt(eventId, "completed");
    await streamReply(callback, eventId, DAILY_LIMIT_REPLY);
    return;
  }

  const address = channelAddressOf(context.messengerId, authorId);
  const presenter = makeInvitePresenter({
    address,
    ensure: dependencies.ensure,
    readHeld: dependencies.readHeld,
    requestId: eventId,
    writeHeld: dependencies.writeHeld,
  });

  await dependencies.writeReceipt(eventId, "pending");
  try {
    await dependencies.runModelTurn({
      callback: presentationAwareCallback(callback, presenter),
      presenter,
      userMessage,
    });
    if (presenter.wasRequested()) await presenter.flush(callback, true);
  } catch (error) {
    // The turn died below the terminal callbacks. If the model already asked
    // for the link, the promised line still ships and the delivery completes;
    // otherwise the failure propagates to the channel's error policy.
    if (!presenter.wasRequested()) {
      await dependencies.writeReceipt(eventId, "completed");
      throw error;
    }
    await presenter.flush(callback, true);
    await callback.onDone();
  }
  await dependencies.writeReceipt(eventId, "completed");
  await dependencies.recordTurn();
};

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
  override async chatWithMessengerContext(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerContext,
  ): Promise<void> {
    const config = loadConfig(this.env);
    await replyToCompanyMessenger(callback, context, userMessage, {
      dailyTurnLimit: config.companyConversation.dailyTurnLimit,
      ensure: (address) =>
        Effect.runPromiseExit(
          this.#withChannelLinks((channelLinks) => channelLinks.ensure(address)),
        ),
      recordActivity: () => this.#recordActivity(context),
      readHeld: () => this.#heldInvite,
      readReceipt: async (eventId) =>
        (await this.ctx.storage.get<ReceiptStatus>(receiptKey(eventId))) ?? null,
      recordTurn: () => this.#recordDailyTurn(),
      runModelTurn: (turn) => this.#runManagedTurn(turn, context),
      turnsToday: () => this.#dailyTurnCount(),
      writeHeld: (held) => {
        this.#heldInvite = held;
      },
      writeReceipt: (eventId, status) => this.ctx.storage.put(receiptKey(eventId), status),
    });
  }

  /**
   * Teardown wakeup scheduled after every turn. Destroys the facet once its
   * address is linked or its idle lifetime elapsed; otherwise chains the next
   * deadline. One stable idempotency payload prevents turns from accumulating
   * redundant lifecycle callbacks; an earlier callback simply re-reads the
   * latest activity and schedules the next required check.
   */
  async expireCompanyConversation(): Promise<void> {
    const stored = this.getConfig<unknown>();
    const state =
      stored === undefined || stored === null
        ? Option.none()
        : Schema.decodeUnknownOption(CompanyConversationState)(stored);
    if (Option.isNone(state)) {
      this.#destroy();
      return;
    }
    const linked = await this.#addressLinked(
      channelAddressOf(state.value.addressChannelId, state.value.addressAuthorId),
    );
    const decision = planTeardown({
      lastActivityAt: state.value.lastActivityAt,
      linked,
      now: new Date(),
    });
    if (decision._tag === "Destroy") {
      this.#destroy();
      return;
    }
    await this.schedule(decision.at, "expireCompanyConversation", COMPANY_TEARDOWN_PAYLOAD, {
      idempotent: true,
    });
  }

  async #runManagedTurn(turn: CompanyModelTurn, context: MessengerContext): Promise<void> {
    this.#activePresenter = turn.presenter;
    try {
      await super.chatWithMessengerContext(turn.userMessage, turn.callback, context, {});
    } finally {
      this.#activePresenter = null;
    }
  }

  async #recordActivity(context: MessengerContext): Promise<void> {
    const authorId = messengerAuthorId(context);
    if (authorId === undefined) return;
    const lastActivityAt = new Date();
    this.configure({
      addressAuthorId: authorId,
      addressChannelId: context.messengerId,
      lastActivityAt: lastActivityAt.toISOString(),
    });
    const acceptanceDeadline = new Date(lastActivityAt.getTime() + ACCEPTANCE_TEARDOWN_MS);
    await this.schedule(acceptanceDeadline, "expireCompanyConversation", COMPANY_TEARDOWN_PAYLOAD, {
      idempotent: true,
    });
  }

  async #dailyTurnCount(): Promise<number> {
    return (await this.ctx.storage.get<number>(dailyTurnKey())) ?? 0;
  }

  async #recordDailyTurn(): Promise<void> {
    const key = dailyTurnKey();
    const current = (await this.ctx.storage.get<number>(key)) ?? 0;
    await this.ctx.storage.put(key, current + 1);
  }

  async #addressLinked(address: typeof ChannelLinks.ChannelAddress.Type): Promise<boolean | null> {
    const resolved = await Effect.runPromiseExit(
      this.#withChannelLinks((channelLinks) => channelLinks.resolve(address)),
    );
    if (Exit.isFailure(resolved)) return null;
    return resolved.value !== null;
  }

  #destroy(): void {
    // Facet destruction delegates to the parent and aborts this isolate; the
    // durable condemned marker finishes teardown on a later wake if needed.
    this.destroy().catch(() => undefined);
  }

  #withChannelLinks<A, E>(
    operation: (channelLinks: ChannelLinks.Interface) => Effect.Effect<A, E>,
  ) {
    const base = Layer.merge(Db.layer({ db: this.env.DB }), BrowserCrypto.layer);
    const services = ChannelLinks.layerFromConfig(loadConfig(this.env)).pipe(Layer.provide(base));
    return Effect.scoped(
      Effect.gen(function* () {
        const channelLinks = yield* ChannelLinks.Service;
        return yield* operation(channelLinks);
      }).pipe(Effect.provide(services)),
    );
  }
}

const receiptKey = (eventId: string) => `osfo-company-receipt:${eventId}`;

const dailyTurnKey = () => `osfo-company-turns:${new Date().toISOString().slice(0, 10)}`;

const streamReply = async (callback: StreamCallback, requestId: string, text: string) => {
  await callback.onStart({ requestId });
  await callback.onEvent(JSON.stringify({ delta: text, type: "text-delta" }));
  await callback.onDone();
};
