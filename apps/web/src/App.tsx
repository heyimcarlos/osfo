import { Button } from "@osfo/ui/components/button";

export function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">Browser reference client</p>
        <h1 className="text-4xl font-semibold tracking-tight">Osfo workspace is ready.</h1>
        <p className="max-w-xl text-base leading-7 text-muted-foreground">
          This small React client proves that applications can consume the shared UI package through
          its public exports.
        </p>
      </div>
      <div>
        <Button type="button">Open the reference Thread</Button>
      </div>
    </main>
  );
}
