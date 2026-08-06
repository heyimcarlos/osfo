import { DatabaseIcon } from "lucide-react";

export function ThreadHeader({ threadId }: { readonly threadId: string }) {
  return (
    <header className="border-b px-4 pb-4 pt-3 sm:px-6">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        <DatabaseIcon className="size-3.5" />
        Osfo durable Thread
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white shadow-sm">
          OS
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">Reference Thread</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">{threadId}</p>
        </div>
        <span className="rounded-full border bg-background px-3 py-1.5 text-xs font-medium shadow-sm">
          Ingress API
        </span>
      </div>
    </header>
  );
}
