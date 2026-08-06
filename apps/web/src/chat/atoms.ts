import { submitThreadMessage } from "@osfo/api/client";
import * as Effect from "effect/Effect";
import * as Atom from "effect/unstable/reactivity/Atom";

export interface ThreadChatOptions {
  readonly authenticationToken: string;
  readonly baseUrl: string;
  readonly threadId: string;
  readonly submitMessage?: typeof submitThreadMessage;
}

export interface SubmitThreadChatMessage {
  readonly content: string;
  readonly idempotencyKey: string;
}

const makeAcceptedThreadMessage = (
  submission: SubmitThreadChatMessage,
  receipt: Effect.Success<ReturnType<typeof submitThreadMessage>>,
) => ({
  content: submission.content,
  receipt,
});

export type AcceptedThreadMessage = ReturnType<typeof makeAcceptedThreadMessage>;

export const makeThreadChat = (options: ThreadChatOptions) => {
  const messages = Atom.make<ReadonlyArray<AcceptedThreadMessage>>([]);
  const submitMessage = options.submitMessage ?? submitThreadMessage;

  const submit = Atom.fn<SubmitThreadChatMessage>()(
    Effect.fn("ThreadChat.submit")(function* (submission, context) {
      const receipt = yield* submitMessage({
        authenticationToken: options.authenticationToken,
        baseUrl: options.baseUrl,
        idempotencyKey: submission.idempotencyKey,
        message: { content: submission.content },
        threadId: options.threadId,
      });
      const accepted = makeAcceptedThreadMessage(submission, receipt);
      const currentMessages = context(messages);
      if (
        !currentMessages.some((message) => message.receipt.userMessageId === receipt.userMessageId)
      ) {
        context.set(messages, [...currentMessages, accepted]);
      }
      return accepted;
    }),
  );

  return { messages, submit };
};

export type ThreadChat = ReturnType<typeof makeThreadChat>;
export type ThreadChatSubmission = Atom.Type<ThreadChat["submit"]>;
