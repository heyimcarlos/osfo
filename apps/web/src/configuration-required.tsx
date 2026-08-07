import { useState } from "react";
import { referenceClientAuthorityStorageKey } from "./reference-client-config";

export interface ReferenceClientAuthorityInput {
  readonly authenticationToken: string;
  readonly threadId: string;
}

export interface ConfigurationRequiredProps {
  readonly onConnect?: (authority: ReferenceClientAuthorityInput) => void;
}

const connectThisTab = (authority: ReferenceClientAuthorityInput) => {
  globalThis.sessionStorage.setItem(referenceClientAuthorityStorageKey, JSON.stringify(authority));
  globalThis.location.reload();
};

export function ConfigurationRequired({ onConnect = connectThisTab }: ConfigurationRequiredProps) {
  const [authenticationToken, setAuthenticationToken] = useState("");
  const [threadId, setThreadId] = useState("");

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="max-w-lg rounded-2xl border bg-card p-8 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Browser reference client
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Connect a Thread</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Enter the reference authority for this tab. The bearer is held only in this tab's session
          storage and is never compiled into the public application bundle.
        </p>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onConnect({ authenticationToken, threadId });
          }}
        >
          <label className="block text-sm font-medium">
            Thread ID
            <input
              className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm"
              name="threadId"
              required
              type="text"
              value={threadId}
              onChange={(event) => setThreadId(event.currentTarget.value)}
            />
          </label>
          <label className="block text-sm font-medium">
            Authentication token
            <input
              autoComplete="off"
              className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm"
              name="authenticationToken"
              required
              type="password"
              value={authenticationToken}
              onChange={(event) => setAuthenticationToken(event.currentTarget.value)}
            />
          </label>
          <button
            className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            type="submit"
          >
            Connect this tab
          </button>
        </form>
      </div>
    </main>
  );
}
