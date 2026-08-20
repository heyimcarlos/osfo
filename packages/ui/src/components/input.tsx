import { Input } from "@base-ui/react/input";
import type { ComponentProps } from "react";

import { cn } from "#lib/utils";

/** Text input with the shared Osfo field treatment. */
function InputField({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <Input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-sm border-2 border-input bg-background px-3 py-1 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { InputField as Input };
