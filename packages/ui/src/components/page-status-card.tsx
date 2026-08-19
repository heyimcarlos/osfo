import type { ComponentProps, ReactNode } from "react";

import { Card, CardDescription, CardHeader } from "#components/card";
import { cn } from "#lib/utils";

/** Shared page-level status presentation for loading, success, and failure states. */
function PageStatusCard({
  className,
  description,
  title,
  ...props
}: Omit<ComponentProps<typeof Card>, "title"> & {
  readonly description: ReactNode;
  readonly title: ReactNode;
}) {
  return (
    <Card
      className={cn(
        "w-full max-w-[34rem] bg-background shadow-[8px_8px_0_var(--foreground)]",
        className,
      )}
      {...props}
    >
      <CardHeader>
        <h1 className="text-4xl font-black uppercase leading-none">{title}</h1>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

export { PageStatusCard };
