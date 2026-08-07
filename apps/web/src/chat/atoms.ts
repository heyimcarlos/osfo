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

type AssistantOutputStatus = Extract<
  ThreadSnapshot["timeline"][number],
  { readonly type: "assistantOutput" }
>["status"];
type ActionReceiptItem = Extract<
  ThreadSnapshot["timeline"][number],
  { readonly type: "actionReceipt" }
>;
type ToolCallResultItem = Extract<
  ThreadSnapshot["timeline"][number],
  { readonly type: "toolCallResult" }
>;
type ActiveToolCallItem = Extract<
  ThreadSnapshot["activeState"][number],
  { readonly type: "activeToolCall" }
>;

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
      readonly status: AssistantOutputStatus;
    }
  | {
      readonly type: "actionReceipt";
      readonly messageId: string;
      readonly agentRunId: string;
      readonly approval: ActionReceiptItem["approval"];
      readonly content: string;
      readonly eventId: string;
      readonly occurredAt: string;
      readonly outcome: ActionReceiptItem["outcome"];
      readonly successBoundary: ActionReceiptItem["successBoundary"];
      readonly threadPosition: string;
      readonly toolCallId: string;
    }
  | {
      readonly type: "toolCallProgress";
      readonly messageId: string;
      readonly agentRunId: string;
      readonly content: string;
      readonly eventId: string;
      readonly occurredAt: string;
      readonly presentation: ActiveToolCallItem["presentation"];
      readonly progress: null | {
        readonly message: string;
      };
      readonly threadPosition: string;
      readonly toolCallId: string;
    }
  | {
      readonly type: "toolCallResult";
      readonly messageId: string;
      readonly agentRunId: string;
      readonly content: string;
      readonly eventId: string;
      readonly occurredAt: string;
      readonly outcome: ToolCallResultItem["outcome"];
      readonly presentation: ToolCallResultItem["presentation"];
      readonly threadPosition: string;
      readonly toolCallId: string;
    };

const toolCallOutcomeText = (outcome: ToolCallResultItem["outcome"]) =>
  outcome.type === "failed" ? `${outcome.type} (${outcome.cause})` : outcome.type;

export const projectCanonicalThreadMessages = (
  snapshot: ThreadSnapshot,
): ReadonlyArray<CanonicalThreadMessage> => {
  const timelineMessages = snapshot.timeline.map((item): CanonicalThreadMessage => {
    const canonical = {
      agentRunId: item.agentRunId,
      eventId: item.source.firstEventId,
      occurredAt: item.source.firstOccurredAt,
      threadPosition: item.source.firstPosition,
    };
    switch (item.type) {
      case "userMessage":
        return {
          ...canonical,
          content: item.content.map((block) => block.text).join(""),
          type: "userMessage",
          messageId: item.userMessageId,
          userMessageId: item.userMessageId,
        };
      case "assistantOutput":
        return {
          ...canonical,
          content: item.content.map((block) => block.text).join(""),
          type: "assistantOutput",
          messageId: item.assistantOutputId,
          assistantOutputId: item.assistantOutputId,
          status: item.status,
        };
      case "toolCallResult":
        return {
          ...canonical,
          content: `${item.presentation.title}\nOutcome: ${toolCallOutcomeText(item.outcome)}`,
          messageId: item.toolCallId,
          outcome: item.outcome,
          presentation: item.presentation,
          toolCallId: item.toolCallId,
          type: "toolCallResult",
        };
      case "actionReceipt":
        return {
          ...canonical,
          approval: item.approval,
          content: [
            item.presentation.title,
            ...item.presentation.fields.map((field) => `${field.label}: ${field.value}`),
            `Outcome: ${item.outcome}`,
            `Boundary: ${item.successBoundary.appliedMeans}`,
            `Does not prove: ${item.successBoundary.doesNotProve}`,
          ].join("\n"),
          messageId: item.toolCallId,
          outcome: item.outcome,
          successBoundary: item.successBoundary,
          toolCallId: item.toolCallId,
          type: "actionReceipt",
        };
    }
  });
  const activeToolCallMessages = snapshot.activeState.flatMap(
    (item): ReadonlyArray<CanonicalThreadMessage> => {
      if (item.type !== "activeToolCall") return [];
      const source = item.progress?.source ?? item.introducedBy;
      return [
        {
          agentRunId: item.agentRunId,
          content: `${item.presentation.title}\n${item.progress?.message ?? "Queued"}`,
          eventId: source.eventId,
          messageId: item.toolCallId,
          occurredAt: source.occurredAt,
          presentation: item.presentation,
          progress:
            item.progress === null
              ? null
              : {
                  message: item.progress.message,
                },
          threadPosition: source.position,
          toolCallId: item.toolCallId,
          type: "toolCallProgress",
        },
      ];
    },
  );

  return [...timelineMessages, ...activeToolCallMessages].sort((left, right) =>
    left.threadPosition === right.threadPosition
      ? 0
      : BigInt(left.threadPosition) < BigInt(right.threadPosition)
        ? -1
        : 1,
  );
};

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
    const synchronize = Effect.suspend(() => {
      let caughtUp = false;
      return synchronizeThreadOnce({
        store,
        transport,
        onProjection: (snapshot) => {
          context.set(messages, projectCanonicalThreadMessages(snapshot));
          if (caughtUp) {
            context.set(synchronization, {
              type: "synchronized",
              throughPosition: snapshot.throughPosition,
            });
          }
        },
        onCaughtUp: (checkpoint) => {
          caughtUp = true;
          context.set(synchronization, {
            type: "synchronized",
            throughPosition: checkpoint.throughPosition,
          });
        },
      }).pipe(
        Effect.andThen(Effect.sync(() => context.set(synchronization, { type: "reconnecting" }))),
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
    });
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
