import type { ComponentProps } from "react";

import { cn } from "#lib/utils";

/** Translucent dashboard panel used by Osfo's glass layouts. */
function GlassPanel({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "rounded-[1.5rem] border border-white/85 bg-white/68 p-5 shadow-[0_14px_36px_rgba(63,88,124,0.11)]",
        className,
      )}
      data-slot="glass-panel"
      {...props}
    />
  );
}

export { GlassPanel };
