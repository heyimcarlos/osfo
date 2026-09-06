import { BrowserInteraction } from "@osfo/api/browser-host";
import type { BrowserApproval, BrowserTaskSummary, BrowserTaskLiveView } from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import { Effect, Option, Schema } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";

import { GlassPanel } from "@osfo/ui/components/glass-panel";
import {
  decideBrowserApproval,
  inspectBrowserApprovals,
  inspectBrowserTasks,
  openBrowserTask,
  resumeBrowserTask,
} from "../lib/api-client";

export interface SettingsBrowserDependencies {
  readonly inspect: typeof inspectBrowserApprovals;
  readonly decide: typeof decideBrowserApproval;
  readonly inspectTasks: typeof inspectBrowserTasks;
  readonly openTask: typeof openBrowserTask;
  readonly resumeTask: typeof resumeBrowserTask;
}
const defaultDependencies: SettingsBrowserDependencies = {
  inspect: inspectBrowserApprovals,
  decide: decideBrowserApproval,
  inspectTasks: inspectBrowserTasks,
  openTask: openBrowserTask,
  resumeTask: resumeBrowserTask,
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
    <>
      <BrowserTasksPanel dependencies={dependencies} />
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
    </>
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

function BrowserTasksPanel({
  dependencies,
}: {
  readonly dependencies: SettingsBrowserDependencies;
}) {
  const [tasks, setTasks] = useState<ReadonlyArray<BrowserTaskSummary> | null>(null);
  const [liveView, setLiveView] = useState<BrowserTaskLiveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const current = ++generation.current;
    void Effect.runPromise(dependencies.inspectTasks).then(
      (result) => {
        if (generation.current !== current) return;
        setTasks(result.items);
        setError(null);
      },
      () => {
        if (generation.current !== current) return;
        setTasks(null);
        setError("Browser tasks are temporarily unavailable. Please refresh.");
      },
    );
  }, [dependencies.inspectTasks]);
  useEffect(() => {
    refresh();
    const current = generation;
    return () => {
      current.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (liveView === null) return undefined;
    const timeout = window.setTimeout(() => setLiveView(null), liveView.expiresInMs);
    return () => window.clearTimeout(timeout);
  }, [liveView]);
  const control = (taskId: string, action: "open" | "resume") => {
    if (inFlight.current) return;
    inFlight.current = true;
    generation.current++;
    setBusy(true);
    setError(null);
    setNotice(null);
    setLiveView(null);
    const operation = Effect.gen(function* () {
      if (action === "resume") {
        yield* dependencies.resumeTask({ taskId });
        return { action: "resume" as const };
      }
      const result = yield* dependencies.openTask({ taskId });
      return { action: "open" as const, result };
    });
    void Effect.runPromise(operation).then(
      (accepted) => {
        inFlight.current = false;
        setBusy(false);
        if (accepted.action === "open") {
          setLiveView(accepted.result);
          setNotice("Osfo is paused. Open the browser to sign in or complete verification.");
        } else {
          setNotice(
            "Browser returned to Osfo. Ask Osfo in chat to continue from a fresh view of the page.",
          );
        }
        refresh();
      },
      () => {
        inFlight.current = false;
        setBusy(false);
        setTasks(null);
        setError("Browser control could not be confirmed. Refresh to check the current status.");
      },
    );
  };
  return (
    <GlassPanel className="mb-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Your browser tasks</h2>
          <p className="mt-2 max-w-2xl text-sm text-[#687896]">
            Open a browser when you need to sign in or complete verification yourself. Each task
            lasts up to 10 minutes. Its browser and sign-in state expire with the task.
          </p>
        </div>
        <Button disabled={busy} type="button" variant="secondary" onClick={refresh}>
          Refresh browsers
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
      {tasks === null ? (
        error === null ? (
          <p className="mt-4">Loading browser tasks...</p>
        ) : null
      ) : tasks.length === 0 ? (
        <p className="mt-4">No active browser tasks. Ask Osfo in chat to browse a website.</p>
      ) : (
        <ul className="mt-5 grid gap-4">
          {tasks.map((task) => (
            <li className="rounded-2xl border border-[#dce7f7] bg-[#f7faff] p-4" key={task.taskId}>
              <p className="break-words text-sm">{task.url}</p>
              <p className="mt-2 text-sm text-[#687896]">
                {task.state === "human"
                  ? "Paused for you. Osfo cannot interact with this browser. When finished, choose Done in the live browser, then Return to Osfo here."
                  : "Available to Osfo."}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button disabled={busy} type="button" onClick={() => control(task.taskId, "open")}>
                  Open browser
                </Button>
                {task.state === "human" ? (
                  <Button
                    disabled={busy}
                    type="button"
                    variant="secondary"
                    onClick={() => control(task.taskId, "resume")}
                  >
                    Return to Osfo
                  </Button>
                ) : null}
                {liveView?.taskId === task.taskId ? (
                  <a
                    className="self-center text-sm underline"
                    href={liveView.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                  >
                    Open live browser
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </GlassPanel>
  );
}
