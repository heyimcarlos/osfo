import type { ComponentProps } from "react";

import { cn } from "#lib/utils";

type ProgressProps = Omit<
  ComponentProps<"div">,
  "aria-valuemax" | "aria-valuemin" | "aria-valuenow" | "children" | "role"
> & {
  readonly indicatorClassName?: string;
  readonly value: number;
};

/** Accessible determinate progress with a value constrained to its legal visual range. */
function Progress({ className, indicatorClassName, value, ...props }: ProgressProps) {
  const normalizedValue = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  return (
    <div
      {...props}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={normalizedValue}
      className={cn("h-2 overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
    >
      <span
        className={cn("block h-full rounded-full bg-primary", indicatorClassName)}
        data-slot="progress-indicator"
        style={{ width: `${normalizedValue}%` }}
      />
    </div>
  );
}

export { Progress };
export type { ProgressProps };
