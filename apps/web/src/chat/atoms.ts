import {
  SnapshotUnavailable,
  ThreadResumeUnavailable,
  isThreadResumeError,
  isThreadSnapshotError,
} from "@osfo/api";
import { getThreadSnapshot, streamThreadEvents, submitThreadMessage } from "@osfo/api/client";
import { InvalidThreadProjection, type ThreadSnapshot } from "@osfo/session";
import { Effect, Stream } from "effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import {
  makeThreadProjectionStore,
  ProjectionStoreUnavailable,
  type ThreadProjectionStore,
} from "./projection-store";
import { synchronizeThreadOnce, type ThreadResumeTransport } from "./resume-thread";

export interface ThreadChatOptions {
  readonly authenticationToken: string;
  readonly baseUrl: string;
  readonly clientInstanceId: string;
  readonly projectionStore?: ThreadProjectionStore;
  readonly resumeTransport?: ThreadResumeTransport;
  readonly threadId: string;
  readonly submitMessage?: typeof submitThreadMessage;
}

export type ThreadSynchronization =
  | { readonly type: "synchronizing" }
  | { readonly type: "reconnecting" }
  | {
      readonly type: "synchronized";
      readonly throughPosition: string;
    };

export interface SubmitThreadChatMessage {
  readonly content: string;
  readonly idempotencyKey: string;
}

export type CanonicalThreadMessage =
  | {
      readonly type: "userMessage";
      readonly messageId: string;
      readonly agentRunId: string;
      readonly content: string;
      readonly eventId: string;
      readonly occurredAt: string;
      readonly threadPosition: string;
      readonly userMessageId: string;
    }
  | {
      readonly type: "assistantOutput";
      readonly messageId: string;
      readonly agentRunId: string;
      readonly assistantOutputId: string;
      readonly content: string;
      readonly eventId: string;
      readonly occurredAt: string;
      readonly threadPosition: string;
      readonly status:
        | { readonly type: "streaming" }
        | { readonly type: "completed" }
        | { readonly type: "interrupted"; readonly cause: "modelCallFailed" };
    };

const messagesFromSnapshot = (snapshot: ThreadSnapshot): ReadonlyArray<CanonicalThreadMessage> =>
  snapshot.timeline.map((item): CanonicalThreadMessage => {
    const source = {
      agentRunId: item.agentRunId,
      content: item.content.map((block) => block.text).join(""),
      eventId: item.source.firstEventId,
      occurredAt: item.source.firstOccurredAt,
      threadPosition: item.source.firstPosition,
    };
    return item.type === "userMessage"
      ? {
          ...source,
          type: "userMessage",
          messageId: item.userMessageId,
          userMessageId: item.userMessageId,
        }
      : {
          ...source,
          type: "assistantOutput",
          messageId: item.assistantOutputId,
          assistantOutputId: item.assistantOutputId,
          status: item.status,
        };
  });

const makeApiResumeTransport = (options: ThreadChatOptions): ThreadResumeTransport => ({
  snapshot: () =>
    getThreadSnapshot({
      authenticationToken: options.authenticationToken,
      baseUrl: options.baseUrl,
      threadId: options.threadId,
    }).pipe(
      Effect.mapError((error) =>
        isThreadSnapshotError(error) ? error : new SnapshotUnavailable(),
      ),
    ),
  stream: (after) =>
    streamThreadEvents({
      after,
      authenticationToken: options.authenticationToken,
      baseUrl: options.baseUrl,
      threadId: options.threadId,
    }).pipe(
      Effect.map(
        Stream.mapError((error) =>
          error instanceof ThreadResumeUnavailable ? error : new ThreadResumeUnavailable(),
        ),
      ),
      Effect.mapError((error) =>
        isThreadResumeError(error) ? error : new ThreadResumeUnavailable(),
      ),
    ),
});

const browserProjectionStore = (threadId: string) =>
  Effect.try({
    try: () => makeThreadProjectionStore({ storage: globalThis.sessionStorage, threadId }),
    catch: (cause) => new ProjectionStoreUnavailable({ cause }),
  });

export const makeThreadChat = (options: ThreadChatOptions) => {
  const messages = Atom.make<ReadonlyArray<CanonicalThreadMessage>>([]);
  const synchronization = Atom.make<ThreadSynchronization>({ type: "synchronizing" });
  const submitMessage = options.submitMessage ?? submitThreadMessage;

  const submit = Atom.fn<SubmitThreadChatMessage>()(
    Effect.fn("ThreadChat.submit")(function* (submission) {
      return yield* submitMessage({
        authenticationToken: options.authenticationToken,
        baseUrl: options.baseUrl,
        idempotencyKey: submission.idempotencyKey,
        message: { content: submission.content },
        threadId: options.threadId,
      });
    }),
  );

  const resumeThread = Effect.fn("ThreadChat.resume")(function* (context: Atom.AtomContext) {
    const store = options.projectionStore ?? (yield* browserProjectionStore(options.threadId));
    const transport = options.resumeTransport ?? makeApiResumeTransport(options);
    const synchronize = synchronizeThreadOnce({
      store,
      transport,
      onProjection: (snapshot) => {
        context.set(messages, messagesFromSnapshot(snapshot));
        context.set(synchronization, {
          type: "synchronized",
          throughPosition: snapshot.throughPosition,
        });
      },
    }).pipe(
      Effect.andThen(Effect.sleep(250)),
      Effect.catchIf(
        () => true,
        (error) =>
          error instanceof InvalidThreadProjection && error.reason === "authorityConflict"
            ? Effect.fail(error)
            : Effect.sync(() => context.set(synchronization, { type: "reconnecting" })).pipe(
                Effect.andThen(Effect.sleep(250)),
              ),
      ),
    );
    yield* Effect.forever(synchronize);
  });

  const resume = Atom.make(resumeThread);

  return {
    clientInstanceId: options.clientInstanceId,
    messages,
    resume,
    submit,
    synchronization,
  };
};

export type ThreadChat = ReturnType<typeof makeThreadChat>;
export type ThreadChatSubmission = Atom.Type<ThreadChat["submit"]>;
