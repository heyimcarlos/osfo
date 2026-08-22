import type { StreamCallback } from "@cloudflare/think";
import { Clock, type Context, Effect, Option } from "effect";

import type { ChannelLinks } from "../../services/channel-links";
import {
  emitTextDelta,
  makeMessengerStream,
  type MessengerDeliveryUnavailable,
} from "./messenger-stream";

/* oxlint-disable eslint/no-underscore-dangle -- Channel Links results use Effect tagged unions. */

const LINKED_RACE_REPLY =
  "This channel is linked, but I could not reach your Osfo Agent. Please try again.";
const INVITE_PREPARATION_REPLY =
  "I could not prepare your invite right now. Please ask me again in a moment.";
const ATTEMPT_ENDED_REPLY = "That linking attempt has ended. Please send your message again.";

/** Invitation material retained only in one facet activation. */
export interface HeldInvite {
  readonly expiresAtMs: number;
  readonly url: URL;
}

/** Transient presentation capability bound to one model turn. */
export interface InvitePresenter {
  readonly flush: (
    callback: StreamCallback,
    ensureStart: boolean,
  ) => Effect.Effect<void, MessengerDeliveryUnavailable>;
  readonly request: () => void;
  readonly wasRequested: () => boolean;
}

/** Build the hold-and-present policy for the current address attempt. */
export const makeInvitePresenter = (options: {
  readonly address: typeof ChannelLinks.ChannelAddress.Type;
  readonly channelLinks: ChannelLinks.Interface;
  readonly previousChannelLinkId: ChannelLinks.ChannelLinkId | null;
  readonly readHeld: () => HeldInvite | null;
  readonly requestId: string;
  readonly writeHeld: (held: HeldInvite | null) => void;
}): InvitePresenter => {
  let requested = false;

  const resolveLine = Effect.fn("CompanyInvitation.resolveLine")(function* () {
    const resolution = yield* options.channelLinks.resolveConversation(options.address).pipe(
      Effect.map(Option.some),
      Effect.catchTag("ChannelLinksUnavailable", () => Effect.succeed(Option.none())),
    );
    if (Option.isNone(resolution)) return INVITE_PREPARATION_REPLY;
    if (resolution.value._tag === "Linked") {
      options.writeHeld(null);
      return LINKED_RACE_REPLY;
    }
    if (resolution.value.previousChannelLinkId !== options.previousChannelLinkId) {
      options.writeHeld(null);
      return ATTEMPT_ENDED_REPLY;
    }

    const nowMs = yield* Clock.currentTimeMillis;
    const existing = options.readHeld();
    if (existing !== null && existing.expiresAtMs > nowMs) return existing.url.href;

    const ensured = yield* options.channelLinks.ensure(options.address).pipe(
      Effect.map(Option.some),
      Effect.catchTag("ChannelLinksUnavailable", () => Effect.succeed(Option.none())),
    );
    if (Option.isNone(ensured)) return INVITE_PREPARATION_REPLY;
    if (ensured.value._tag === "Linked") {
      options.writeHeld(null);
      return LINKED_RACE_REPLY;
    }
    options.writeHeld({
      expiresAtMs: ensured.value.expiresAt.getTime(),
      url: ensured.value.verificationUrl,
    });
    return ensured.value.verificationUrl.href;
  });

  const flush = Effect.fn("CompanyInvitation.flush")(function* (
    callback: StreamCallback,
    ensureStart: boolean,
  ) {
    if (!requested) return;
    requested = false;
    const line = yield* resolveLine();
    const stream = makeMessengerStream(callback);
    if (ensureStart)
      yield* stream.use("start", (raw) => raw.onStart({ requestId: options.requestId }));
    yield* emitTextDelta(stream, `\n${line}`);
  });

  return {
    flush,
    request: () => {
      requested = true;
    },
    wasRequested: () => requested,
  };
};

/** Attach a requested invitation after every terminal model signal. */
export const presentationAwareCallback = Effect.fn("CompanyInvitation.callback")(function* (
  real: StreamCallback,
  presenter: InvitePresenter,
): Effect.fn.Return<StreamCallback, MessengerDeliveryUnavailable> {
  const context: Context.Context<never> = yield* Effect.context();
  const runPromise = Effect.runPromiseWith(context);
  const stream = makeMessengerStream(real);
  let started = false;
  const flushIfRequested = () => presenter.flush(real, !started);

  return {
    onStart: (event) => {
      started = true;
      return runPromise(stream.use("start", (raw) => raw.onStart(event)));
    },
    onEvent: (event) => runPromise(stream.use("event", (raw) => raw.onEvent(event))),
    onDone: () =>
      runPromise(
        flushIfRequested().pipe(Effect.andThen(stream.use("done", (raw) => raw.onDone()))),
      ),
    onError: (error) =>
      runPromise(
        presenter.wasRequested()
          ? flushIfRequested().pipe(Effect.andThen(stream.use("done", (raw) => raw.onDone())))
          : stream.use("error", (raw) => raw.onError(error)),
      ),
    onInterrupted: () =>
      runPromise(
        flushIfRequested().pipe(
          Effect.andThen(stream.use("interrupted", (raw) => raw.onInterrupted?.())),
        ),
      ),
  } satisfies StreamCallback;
});
