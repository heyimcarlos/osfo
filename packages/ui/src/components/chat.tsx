import type { ComponentProps, ReactNode } from "react";
import { ArrowUpIcon, LoaderCircleIcon, MessageCircleIcon } from "lucide-react";

import { Bubble, BubbleContent } from "#components/bubble";
import { Button } from "#components/button";
import {
  MessageComposer,
  MessageComposerFooter,
  MessageComposerTextarea,
} from "#components/message-composer";
import { Message, MessageContent, MessageFooter } from "#components/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "#components/message-scroller";
import { cn } from "#lib/utils";

interface ChatMessage {
  readonly content: string;
  readonly footer?: ReactNode;
  readonly id: string;
  readonly role: "assistant" | "user";
}

interface ChatProps extends Omit<ComponentProps<"section">, "onSubmit" | "title"> {
  readonly description?: ReactNode;
  readonly draft: string;
  readonly emptyDescription?: ReactNode;
  readonly emptyTitle?: ReactNode;
  readonly error?: ReactNode;
  readonly isSubmitting?: boolean;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly onDraftChange: (draft: string) => void;
  readonly onSubmit: () => void;
  readonly placeholder?: string;
  readonly status?: ReactNode;
  readonly title: ReactNode;
}

function Chat({
  className,
  description,
  draft,
  emptyDescription = "Start a conversation when you are ready.",
  emptyTitle = "How can I help?",
  error,
  isSubmitting = false,
  messages,
  onDraftChange,
  onSubmit,
  placeholder = "Write a message",
  status,
  title,
  ...props
}: ChatProps) {
  return (
    <section
      data-slot="chat"
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-card sm:rounded-2xl sm:border sm:shadow-xl sm:shadow-slate-900/5",
        className,
      )}
      {...props}
    >
      <ChatHeader description={description} status={status} title={title} />
      <ChatMessages
        emptyDescription={emptyDescription}
        emptyTitle={emptyTitle}
        isSubmitting={isSubmitting}
        messages={messages}
      />
      <div className="border-t bg-card/90 p-4 backdrop-blur-sm sm:px-6 sm:py-4">
        <ChatComposer
          draft={draft}
          isSubmitting={isSubmitting}
          onDraftChange={onDraftChange}
          onSubmit={onSubmit}
          placeholder={placeholder}
        />
        {error ? (
          <p className="mt-2 px-2 text-xs leading-5 text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ChatHeader({
  description,
  status,
  title,
}: Pick<ChatProps, "description" | "status" | "title">) {
  return (
    <header data-slot="chat-header" className="border-b px-4 py-4 sm:px-6">
      <div className="flex items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-sm">
          <MessageCircleIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">{title}</h1>
          {description ? (
            <p className="truncate text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {status ? (
          <div className="shrink-0 text-xs text-muted-foreground" role="status">
            {status}
          </div>
        ) : null}
      </div>
    </header>
  );
}

function ChatMessages({
  emptyDescription,
  emptyTitle,
  isSubmitting,
  messages,
}: Pick<ChatProps, "emptyDescription" | "emptyTitle" | "isSubmitting" | "messages">) {
  const lastMessageId = messages.at(-1)?.id;

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-6 px-4 py-6 sm:px-7">
            {messages.length === 0 ? (
              <MessageScrollerItem className="flex min-h-[22rem] items-center justify-center">
                <div className="mx-auto max-w-sm text-center">
                  <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-blue-600 text-xl text-white shadow-sm">
                    ✦
                  </div>
                  <h2 className="text-xl font-semibold tracking-tight">{emptyTitle}</h2>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{emptyDescription}</p>
                </div>
              </MessageScrollerItem>
            ) : null}
            {messages.map((message) => (
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.id === lastMessageId}
              >
                <Message align={message.role === "user" ? "end" : "start"}>
                  <MessageContent>
                    <Bubble
                      align={message.role === "user" ? "end" : "start"}
                      className="max-w-[min(34rem,86vw)]"
                      variant={message.role === "user" ? "default" : "secondary"}
                    >
                      <BubbleContent
                        className={cn(
                          "whitespace-pre-wrap",
                          message.role === "user" && "bg-blue-600 text-white",
                        )}
                      >
                        {message.content}
                      </BubbleContent>
                    </Bubble>
                    {message.footer ? <MessageFooter>{message.footer}</MessageFooter> : null}
                  </MessageContent>
                </Message>
              </MessageScrollerItem>
            ))}
            {isSubmitting ? (
              <MessageScrollerItem>
                <div
                  className="flex items-center gap-2 px-1 text-sm text-muted-foreground"
                  role="status"
                >
                  <LoaderCircleIcon className="size-4 animate-spin" />
                  Sending message...
                </div>
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton className="shadow-md" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function ChatComposer({
  draft,
  isSubmitting,
  onDraftChange,
  onSubmit,
  placeholder,
}: Pick<ChatProps, "draft" | "isSubmitting" | "onDraftChange" | "onSubmit" | "placeholder">) {
  const canSubmit = draft.trim().length > 0 && !isSubmitting;

  const submit = () => {
    if (canSubmit) onSubmit();
  };

  return (
    <MessageComposer
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="sr-only" htmlFor="chat-message">
        Message
      </label>
      <MessageComposerTextarea
        id="chat-message"
        maxLength={16_384}
        placeholder={isSubmitting ? "Sending message..." : placeholder}
        value={draft}
        disabled={isSubmitting}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <MessageComposerFooter>
        <span className="text-xs text-muted-foreground">Shift + Enter for a new line</span>
        <Button
          type="submit"
          size="icon-sm"
          className="rounded-full bg-blue-600 hover:bg-blue-700"
          disabled={!canSubmit}
          aria-label="Send message"
        >
          {isSubmitting ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpIcon />}
        </Button>
      </MessageComposerFooter>
    </MessageComposer>
  );
}

export { Chat, ChatComposer, ChatHeader, ChatMessages };
export type { ChatMessage, ChatProps };
