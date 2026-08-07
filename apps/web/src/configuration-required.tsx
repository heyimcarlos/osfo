import type { DevelopmentBootstrapCapability, DevelopmentDemoSession } from "@osfo/api";
import { createDevelopmentDemoSession, getDevelopmentBootstrapCapability } from "@osfo/api/client";
import { Effect, Exit } from "effect";
import { useEffect, useState } from "react";
import { referenceClientAuthorityStorageKey } from "./reference-client-config";

export interface ReferenceClientAuthorityInput {
  readonly authenticationToken: string;
  readonly threadId: string;
}

export interface ConfigurationRequiredProps {
  readonly createDemoSession?: (options: {
    readonly accessCode: string;
    readonly baseUrl: string;
  }) => Effect.Effect<DevelopmentDemoSession, unknown>;
  readonly getBootstrapCapability?: (options: {
    readonly baseUrl: string;
  }) => Effect.Effect<DevelopmentBootstrapCapability, unknown>;
  readonly onConnect?: (authority: ReferenceClientAuthorityInput) => void;
}

const connectThisTab = (authority: ReferenceClientAuthorityInput) => {
  globalThis.sessionStorage.setItem(referenceClientAuthorityStorageKey, JSON.stringify(authority));
  globalThis.location.reload();
};

export function ConfigurationRequired({
  createDemoSession = createDevelopmentDemoSession,
  getBootstrapCapability = getDevelopmentBootstrapCapability,
  onConnect = connectThisTab,
}: ConfigurationRequiredProps) {
  const [accessCode, setAccessCode] = useState("");
  const [authenticationToken, setAuthenticationToken] = useState("");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapEnabled, setBootstrapEnabled] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [threadId, setThreadId] = useState("");

  useEffect(() => {
    let active = true;
    void Effect.runPromise(
      getBootstrapCapability({ baseUrl: globalThis.location.origin }).pipe(
        Effect.match({
          onFailure: () => false,
          onSuccess: (capability) => capability.enabled && capability.scope === "development",
        }),
      ),
    ).then((enabled) => {
      if (active) setBootstrapEnabled(enabled);
    });
    return () => {
      active = false;
    };
  }, [getBootstrapCapability]);

  const generateDemoSession = async () => {
    setBootstrapError(null);
    setIsGenerating(true);
    const result = await Effect.runPromiseExit(
      createDemoSession({ accessCode, baseUrl: globalThis.location.origin }),
    );
    setIsGenerating(false);

    if (Exit.isFailure(result)) {
      setAccessCode("");
      setBootstrapError(
        "A development session could not be generated. Check the access code or use manual entry.",
      );
      return;
    }

    setAccessCode("");
    setAuthenticationToken(result.value.authenticationToken);
    setThreadId(result.value.threadId);
  };

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
        {bootstrapEnabled ? (
          <section className="mt-5 rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-blue-700 dark:text-blue-300">
              Development demo only
            </p>
            <p className="mt-2 text-sm leading-5 text-muted-foreground">
              Generate a temporary development Thread and authentication token. This does not
              qualify or access production.
            </p>
            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void generateDemoSession();
              }}
            >
              <label className="block text-sm font-medium">
                Demo access code
                <input
                  autoComplete="off"
                  className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm"
                  name="accessCode"
                  required
                  type="password"
                  value={accessCode}
                  onChange={(event) => setAccessCode(event.currentTarget.value)}
                />
              </label>
              {bootstrapError === null ? null : (
                <p className="text-sm text-destructive" role="alert">
                  {bootstrapError}
                </p>
              )}
              <button
                className="w-full rounded-lg border border-blue-600 bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={accessCode.length === 0 || isGenerating}
                type="submit"
              >
                {isGenerating ? "Generating…" : "Generate new Thread"}
              </button>
            </form>
          </section>
        ) : null}
        {bootstrapEnabled ? (
          <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-[0.12em] text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            Manual entry
            <span className="h-px flex-1 bg-border" />
          </div>
        ) : null}
        <form
          className={bootstrapEnabled ? "space-y-4" : "mt-5 space-y-4"}
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
