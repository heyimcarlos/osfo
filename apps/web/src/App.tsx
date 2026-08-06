import { useAtom, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { useState } from "react";
import type { ThreadChat } from "./chat/atoms";
import { SubmissionError } from "./chat/submission-error";
import { ThreadComposer } from "./chat/thread-composer";
import { ThreadHeader } from "./chat/thread-header";
import { ThreadMessages } from "./chat/thread-messages";

export interface AppProps {
  readonly chat: ThreadChat;
  readonly threadId: string;
}

export function App({ chat, threadId }: AppProps) {
  const messages = useAtomValue(chat.messages);
  const [submission, submit] = useAtom(chat.submit, { mode: "promiseExit" });
  const [content, setContent] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState<string>();
  const isSubmitting = AsyncResult.isWaiting(submission);

  const send = async () => {
    const message = content.trim();
    if (message.length === 0 || isSubmitting) return;

    const key = idempotencyKey ?? crypto.randomUUID();
    setIdempotencyKey(key);
    const exit = await submit({ content: message, idempotencyKey: key });
    if (Exit.isSuccess(exit)) {
      setContent("");
      setIdempotencyKey(undefined);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[radial-gradient(circle_at_top,oklch(0.96_0.035_250),oklch(0.985_0.006_250)_42%,oklch(0.965_0.008_250))] sm:p-6">
      <section className="flex h-dvh w-full max-w-3xl flex-col overflow-hidden bg-card sm:h-[min(52rem,calc(100dvh-3rem))] sm:rounded-2xl sm:border sm:shadow-xl sm:shadow-slate-900/5">
        <ThreadHeader threadId={threadId} />
        <ThreadMessages messages={messages} submission={submission} />
        <div className="border-t bg-card/90 p-4 backdrop-blur-sm sm:px-6 sm:py-4">
          <ThreadComposer
            content={content}
            isSubmitting={isSubmitting}
            onContentChange={(nextContent) => {
              setContent(nextContent);
              setIdempotencyKey(crypto.randomUUID());
            }}
            onSubmit={send}
          />
          <SubmissionError submission={submission} />
        </div>
      </section>
    </main>
  );
}
