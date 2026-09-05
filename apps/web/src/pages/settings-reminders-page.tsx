import type { ReminderApproval } from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";

import { GlassPanel } from "@osfo/ui/components/glass-panel";
import { decideReminderApproval, inspectReminderApprovals } from "../lib/api-client";

export interface SettingsRemindersDependencies {
  readonly inspect: typeof inspectReminderApprovals;
  readonly decide: typeof decideReminderApproval;
}
const defaultDependencies: SettingsRemindersDependencies = {
  inspect: inspectReminderApprovals,
  decide: decideReminderApproval,
};

/** Authenticated exact Reminder approval controls. */
export function SettingsRemindersPage({
  dependencies = defaultDependencies,
}: {
  readonly dependencies?: SettingsRemindersDependencies;
}) {
  const [items, setItems] = useState<ReadonlyArray<ReminderApproval> | null>(null);
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
          setError("Reminders are temporarily unavailable. Please refresh.");
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
            ? "Reminder approved."
            : "Reminder rejected. No Reminder was created or changed.",
        );
        refresh();
      },
      () => {
        inFlight.current = false;
        setBusy(false);
        setItems(null);
        setError(
          "This Reminder decision could not be recorded. Refresh to check its current approval.",
        );
      },
    );
  };
  return (
    <GlassPanel className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Pending Reminders</h2>
          <p className="mt-2 max-w-2xl text-sm text-[#687896]">
            Review the exact private message, schedule, and consequences before approving.
          </p>
        </div>
        <Button disabled={busy} type="button" variant="secondary" onClick={refresh}>
          Refresh Reminders
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
          <p className="mt-4">Loading Reminders...</p>
        ) : null
      ) : items.length === 0 ? (
        <p className="mt-4">
          No Reminder awaits approval. Ask Osfo in your linked conversation to prepare one.
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
                {approval.fields.map((field) => (
                  <div key={field.name}>
                    <dt className="font-semibold">{field.label}</dt>
                    <dd className="whitespace-pre-wrap break-words">{field.value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-sm text-[#7b4d1d]">{approval.consequences.join(" ")}</p>
              <div className="mt-4 flex gap-2">
                <Button
                  disabled={busy}
                  type="button"
                  onClick={() => decide(approval.presentationId, "approve")}
                >
                  Approve exact Reminder
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
