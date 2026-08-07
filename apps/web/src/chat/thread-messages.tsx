import { Bubble, BubbleContent } from "@osfo/ui/components/bubble";
import { Marker, MarkerContent, MarkerIcon } from "@osfo/ui/components/marker";
import { Message, MessageContent, MessageFooter } from "@osfo/ui/components/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@osfo/ui/components/message-scroller";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { LoaderCircleIcon } from "lucide-react";
import type { CanonicalThreadMessage, ThreadChatSubmission } from "./atoms";

export function ThreadMessages({
  messages,
  submission,
}: {
  readonly messages: ReadonlyArray<CanonicalThreadMessage>;
  readonly submission: ThreadChatSubmission;
}) {
  const isSubmitting = AsyncResult.isWaiting(submission);
  const lastMessageId = messages.at(-1)?.messageId;

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-6 px-4 py-6 sm:px-7">
            {messages.length === 0 && !isSubmitting ? <EmptyThread /> : null}
            {messages.map((message) => (
              <CanonicalMessage
                key={message.messageId}
                message={message}
                scrollAnchor={message.messageId === lastMessageId}
              />
            ))}
            {isSubmitting ? <AdmissionPending /> : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton className="shadow-md" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function CanonicalMessage({
  message,
  scrollAnchor,
}: {
  readonly message: CanonicalThreadMessage;
  readonly scrollAnchor: boolean;
}) {
  return (
    <MessageScrollerItem messageId={message.messageId} scrollAnchor={scrollAnchor}>
      <Message align={message.type === "userMessage" ? "end" : "start"}>
        <MessageContent>
          <Bubble
            align={message.type === "userMessage" ? "end" : "start"}
            className="max-w-[min(34rem,86vw)]"
          >
            <BubbleContent
              className={
                message.type === "userMessage"
                  ? "whitespace-pre-wrap bg-blue-600 text-white"
                  : "whitespace-pre-wrap"
              }
            >
              {message.content}
            </BubbleContent>
          </Bubble>
          {message.type === "assistantOutput" && message.status.type === "interrupted" ? (
            <p className="text-xs text-destructive">Assistant output interrupted</p>
          ) : null}
          <MessageFooter className={message.type === "userMessage" ? "items-end" : "items-start"}>
            <details
              className={
                message.type === "userMessage"
                  ? "group max-w-full text-right"
                  : "group max-w-full text-left"
              }
            >
              <summary className="cursor-pointer list-none rounded-md px-2 py-1 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
                Canonical at position {message.threadPosition}
              </summary>
              <dl className="mt-2 grid gap-1 rounded-lg border bg-background p-3 text-left font-mono text-[11px] leading-5 shadow-sm">
                <CanonicalField label="Event" value={message.eventId} />
                <CanonicalField
                  label={
                    message.type === "userMessage"
                      ? "Message"
                      : message.type === "assistantOutput"
                        ? "Output"
                        : "Action"
                  }
                  value={
                    message.type === "userMessage"
                      ? message.userMessageId
                      : message.type === "assistantOutput"
                        ? message.assistantOutputId
                        : message.toolCallId
                  }
                />
                <CanonicalField label="AgentRun" value={message.agentRunId} />
                <CanonicalField label="Committed" value={message.occurredAt} />
              </dl>
            </details>
          </MessageFooter>
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  );
}

function CanonicalField({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}

function EmptyThread() {
  return (
    <MessageScrollerItem className="flex min-h-[22rem] items-center justify-center">
      <div className="mx-auto max-w-sm text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-blue-600 text-xl text-white shadow-sm">
          ✦
        </div>
        <h2 className="text-xl font-semibold tracking-tight">Start the durable Thread</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Send one message to create its canonical input, pending AgentRun, reservation, and outbox
          obligation in PostgreSQL.
        </p>
      </div>
    </MessageScrollerItem>
  );
}

function AdmissionPending() {
  return (
    <MessageScrollerItem>
      <Marker role="status" aria-label="Osfo is accepting the message" className="px-1">
        <MarkerIcon>
          <LoaderCircleIcon className="animate-spin" />
        </MarkerIcon>
        <MarkerContent className="shimmer">Accepting message...</MarkerContent>
      </Marker>
    </MessageScrollerItem>
  );
}
