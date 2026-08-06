import { Button } from "@osfo/ui/components/button";
import {
  MessageComposer,
  MessageComposerFooter,
  MessageComposerTextarea,
} from "@osfo/ui/components/message-composer";
import { ArrowUpIcon, LoaderCircleIcon } from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";

export interface ThreadComposerProps {
  readonly content: string;
  readonly isSubmitting: boolean;
  readonly onContentChange: (content: string) => void;
  readonly onSubmit: () => Promise<void> | void;
}

export function ThreadComposer({
  content,
  isSubmitting,
  onContentChange,
  onSubmit,
}: ThreadComposerProps) {
  const canSubmit = content.trim().length > 0 && !isSubmitting;

  const submit = () => {
    if (canSubmit) void onSubmit();
  };

  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const submitFromKeyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <MessageComposer onSubmit={submitForm}>
      <label className="sr-only" htmlFor="thread-message">
        Message Osfo
      </label>
      <MessageComposerTextarea
        id="thread-message"
        maxLength={16_384}
        placeholder={isSubmitting ? "Accepting message..." : "Message Osfo"}
        value={content}
        disabled={isSubmitting}
        onChange={(event) => onContentChange(event.target.value)}
        onKeyDown={submitFromKeyboard}
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
