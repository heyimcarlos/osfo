import type { ComponentProps } from "react";
import { cn } from "#lib/utils";
import { Textarea } from "#components/textarea";

function MessageComposer({ className, ...props }: ComponentProps<"form">) {
  return (
    <form
      data-slot="message-composer"
      className={cn(
        "rounded-2xl border bg-card p-2 shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring/25",
        className,
      )}
      {...props}
    />
  );
}

function MessageComposerTextarea({ className, ...props }: ComponentProps<typeof Textarea>) {
  return (
    <Textarea
      data-slot="message-composer-textarea"
      className={cn(
        "max-h-40 min-h-12 resize-none border-0 bg-transparent px-2 py-2 text-[0.9375rem] shadow-none focus-visible:ring-0 dark:bg-transparent",
        className,
      )}
      rows={1}
      {...props}
    />
  );
}

function MessageComposerFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-composer-footer"
      className={cn("flex items-center justify-between gap-3 px-1 pb-1", className)}
      {...props}
    />
  );
}

export { MessageComposer, MessageComposerFooter, MessageComposerTextarea };
