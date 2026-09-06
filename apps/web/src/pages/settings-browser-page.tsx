import { BrowserInteraction } from "@osfo/api/browser-host";
import type { BrowserApproval } from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import { Effect, Option, Schema } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";

import { GlassPanel } from "@osfo/ui/components/glass-panel";
import { decideBrowserApproval, inspectBrowserApprovals } from "../lib/api-client";

export interface SettingsBrowserDependencies {
  readonly inspect: typeof inspectBrowserApprovals;
  readonly decide: typeof decideBrowserApproval;
}
const defaultDependencies: SettingsBrowserDependencies = {
  inspect: inspectBrowserApprovals,
  decide: decideBrowserApproval,
};

/** Authenticated exact browser interaction approval controls. */
export function SettingsBrowserPage({
  dependencies = defaultDependencies,
}: {
  readonly dependencies?: SettingsBrowserDependencies;
}) {
  const [items, setItems] = useState<ReadonlyArray<BrowserApproval> | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const refreshGeneration = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(() => {
    const generation = ++refreshGeneration.current;
    setError(null);
    void Effect.runPromise(dependencies.inspect).then(
      (result) => {
        if (refreshGeneration.current === generation) setItems(result.items);
      },
      () => {
        if (refreshGeneration.current === generation) {
          setItems(null);
          setError("Browser interactions are temporarily unavailable. Please refresh.");
        }
      },
    );
  }, [dependencies.inspect]);
  useEffect(() => {
    refresh();
    const generation = refreshGeneration;
    return () => {
      generation.current++;
    };
  }, [refresh]);
  const decide = (presentationId: string, decision: "approve" | "reject") => {
    if (inFlight.current) return;
    inFlight.current = true;
    refreshGeneration.current++;
    setBusy(true);
    setError(null);
    setNotice(null);
    void Effect.runPromise(dependencies.decide({ presentationId, decision })).then(
      (accepted) => {
        inFlight.current = false;
        setBusy(false);
        setItems(
          (current) => current?.filter((item) => item.presentationId !== presentationId) ?? null,
        );
        setNotice(
          accepted.decision === "approved"
            ? "Approved. I’ll send the result in your chat."
            : "Rejected. This action will not run.",
        );
        refresh();
      },
      () => {
        inFlight.current = false;
        setBusy(false);
        setItems(null);
        setError("Your decision could not be confirmed. Refresh to check the current status.");
      },
    );
  };
  return (
    <GlassPanel className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Review browser actions</h2>
          <p className="mt-2 max-w-2xl text-sm text-[#687896]">
            Check where Osfo will go, what it will do, and what will happen.
          </p>
        </div>
        <Button disabled={busy} type="button" variant="secondary" onClick={refresh}>
          Refresh
        </Button>
      </div>
      {error === null ? null : (
        <p className="mt-4 text-sm text-[#a82d3f]" role="alert">
          {error}
        </p>
      )}
      {notice === null ? null : (
        <p className="mt-4 text-sm text-[#22613c]" role="status">
          {notice}
        </p>
      )}
      {items === null ? (
        error === null ? (
          <p className="mt-4">Loading browser actions...</p>
        ) : null
      ) : items.length === 0 ? (
        <p className="mt-4">
          No browser action needs approval. Ask Osfo in your chat to prepare one.
        </p>
      ) : (
        <ul className="mt-5 grid gap-4">
          {items.map((approval) => (
            <li
              className="rounded-2xl border border-[#dce7f7] bg-[#f7faff] p-4"
              key={approval.presentationId}
            >
              <h3 className="font-semibold">{approval.title}</h3>
              <p className="mt-1 text-sm text-[#687896]">{approval.description}</p>
              <dl className="mt-3 grid gap-2 text-sm">
                {approval.fields
                  .filter((field) => field.name !== "taskId" && field.name !== "observationId")
                  .map((field) => (
                    <div key={field.name}>
                      <dt className="font-semibold">{field.label}</dt>
                      <dd className="whitespace-pre-wrap break-words">
                        {field.name === "interaction"
                          ? describeInteraction(field.value)
                          : field.value}
                      </dd>
                    </div>
                  ))}
              </dl>
              <details className="mt-3 text-sm text-[#687896]">
                <summary>Approval references</summary>
                <dl className="mt-2 grid gap-2">
                  {approval.fields
                    .filter((field) => field.name === "taskId" || field.name === "observationId")
                    .map((field) => (
                      <div key={field.name}>
                        <dt>{field.label}</dt>
                        <dd className="break-words">{field.value}</dd>
                      </div>
                    ))}
                </dl>
              </details>
              <p className="mt-3 text-sm text-[#7b4d1d]">{approval.consequences.join(" ")}</p>
              <div className="mt-4 flex gap-2">
                <Button
                  disabled={busy}
                  type="button"
                  onClick={() => decide(approval.presentationId, "approve")}
                >
                  Approve
                </Button>
                <Button
                  disabled={busy}
                  type="button"
                  variant="secondary"
                  onClick={() => decide(approval.presentationId, "reject")}
                >
                  Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </GlassPanel>
  );
}

const describeInteraction = (value: string): string => {
  const decoded = Schema.decodeOption(Schema.fromJsonString(BrowserInteraction))(value);
  if (Option.isNone(decoded)) return value;
  const interaction = decoded.value;
  return BrowserInteraction.match(interaction, {
    Click: () => "Click the visible target shown above.",
    Fill: (filled) => `Fill the visible target with exactly: ${filled.value}`,
    Select: (selected) => `Select exactly: ${selected.value}`,
  });
};
