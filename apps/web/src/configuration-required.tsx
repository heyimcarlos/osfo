export function ConfigurationRequired() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="max-w-lg rounded-2xl border bg-card p-8 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Browser reference client
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Connect a local Thread</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Add <code>VITE_OSFO_THREAD_ID</code> and <code>VITE_OSFO_AUTHENTICATION_TOKEN</code>
          to the root <code>.env</code>, seed the reference authority, then restart development.
        </p>
        <pre className="mt-5 overflow-x-auto rounded-xl bg-muted p-4 text-xs leading-6">
          bun run db:seed:reference{"\n"}bun run dev
        </pre>
      </div>
    </main>
  );
}
