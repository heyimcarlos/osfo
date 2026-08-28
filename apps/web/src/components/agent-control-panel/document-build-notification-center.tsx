import type { DocumentBuildNotificationSummary } from "@osfo/api";
import { Effect } from "effect";
import { FileCheck2, FileClock, FileX2, Hammer, X } from "lucide-react";
import { useRef, useState } from "react";

import { apiBaseURL } from "../../config";
import { inspectDocumentBuildNotifications } from "../../lib/api-client";

/* oxlint-disable eslint/no-underscore-dangle -- The load state is an Effect-style discriminated union. */

/** Authenticated safe status and download projection for delivered Document Builds. */
export function DocumentBuildNotificationCenter() {
  return (
    <DocumentBuildNotificationCenterWithLoader
      loadNotifications={() => Effect.runPromise(inspectDocumentBuildNotifications)}
    />
  );
}

export function DocumentBuildNotificationCenterWithLoader({
  loadNotifications,
}: {
  readonly loadNotifications: () => Promise<{
    readonly items: ReadonlyArray<DocumentBuildNotificationSummary>;
  }>;
}) {
  const [loadState, setLoadState] = useState<NotificationLoadState>({ _tag: "Loading" });
  const [open, setOpen] = useState(false);
  const loadGeneration = useRef(0);
  const load = () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoadState({ _tag: "Loading" });
    void loadNotifications().then(
      (notifications) => {
        if (loadGeneration.current === generation) {
          setLoadState({ _tag: "Ready", items: notifications.items });
        }
      },
      () => {
        if (loadGeneration.current === generation) setLoadState({ _tag: "Unavailable" });
      },
    );
  };
  const openCenter = () => {
    setOpen(true);
    load();
  };
  return (
    <DocumentBuildNotificationCenterContent
      loadState={loadState}
      open={open}
      onClose={() => setOpen(false)}
      onOpen={openCenter}
      onRetry={load}
    />
  );
}

export type NotificationLoadState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly items: ReadonlyArray<DocumentBuildNotificationSummary> }
  | { readonly _tag: "Unavailable" };

export function DocumentBuildNotificationCenterContent({
  loadState,
  onClose,
  onOpen,
  onRetry,
  open,
}: {
  readonly loadState: NotificationLoadState;
  readonly onClose: () => void;
  readonly onOpen: () => void;
  readonly onRetry: () => void;
  readonly open: boolean;
}) {
  const count = loadState._tag === "Ready" ? loadState.items.length : 0;
  return (
    <div className="relative">
      <button
        aria-label={`Document Build notifications${count === 0 ? "" : `, ${count} update${count === 1 ? "" : "s"}`}`}
        className="relative grid size-11 place-items-center rounded-full border border-white/80 bg-white/55 text-[#18223f] shadow-[0_8px_20px_rgba(45,68,110,0.12)] transition hover:bg-white/80 focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:ring-offset-2 focus-visible:outline-none"
        type="button"
        onClick={onOpen}
      >
        <Hammer aria-hidden="true" className="size-5" />
      </button>
      {open ? (
        <section
          aria-label="Document Build notifications"
          className="absolute top-13 right-0 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-white/85 bg-white/95 p-4 text-left shadow-[0_18px_45px_rgba(45,68,110,0.22)] backdrop-blur-xl"
          role="dialog"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold text-[#101936]">Document Builds</h2>
            <button
              aria-label="Close Document Build notifications"
              className="grid size-9 place-items-center rounded-full hover:bg-[#edf4ff]"
              type="button"
              onClick={onClose}
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
          {loadState._tag === "Loading" ? (
            <p className="mt-4 text-sm text-[#687896]">Loading Document Build updates...</p>
          ) : loadState._tag === "Unavailable" ? (
            <div className="mt-4 text-sm text-[#687896]" role="alert">
              <p>Document Build updates are temporarily unavailable.</p>
              <button
                className="mt-2 font-semibold text-[#2568ca] hover:underline"
                type="button"
                onClick={onRetry}
              >
                Retry
              </button>
            </div>
          ) : loadState.items.length === 0 ? (
            <p className="mt-4 text-sm text-[#687896]">No Document Build updates yet.</p>
          ) : (
            <ul className="mt-3 grid max-h-80 gap-2 overflow-auto">
              {loadState.items.map((item) => (
                <NotificationItem item={item} key={`${item.workflowId}:${item.kind}`} />
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

function NotificationItem({ item }: { readonly item: DocumentBuildNotificationSummary }) {
  const presentation = notificationPresentation(item);
  const Icon = presentation.icon;
  return (
    <li className="rounded-xl border border-[#dce7f7] bg-[#f7faff] p-3">
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className={`mt-0.5 size-5 shrink-0 ${presentation.color}`} />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#101936]">{presentation.title}</p>
          <p className="mt-1 text-xs text-[#687896]">{presentation.description}</p>
          {item.kind === "terminal" &&
          item.state === "success" &&
          item.artifactContentId !== null ? (
            <a
              className="mt-2 inline-flex text-xs font-semibold text-[#2568ca] hover:underline"
              href={documentExportUrl(item.artifactContentId)}
            >
              Download {item.format.toUpperCase()}
            </a>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export const documentExportUrl = (contentId: string, baseUrl = apiBaseURL) =>
  new URL(
    `/documents/export?contentId=${encodeURIComponent(contentId)}`,
    `${baseUrl.replace(/\/$/u, "")}/`,
  ).href;

const notificationPresentation = (item: DocumentBuildNotificationSummary) => {
  if (item.kind === "previewReady")
    return {
      color: "text-[#2f7df4]",
      description: "A validated preview is retained while the build finishes.",
      icon: FileClock,
      title: "Preview ready",
    };
  if (item.state === "success")
    return {
      color: "text-[#28a969]",
      description: "The validated document is ready to download.",
      icon: FileCheck2,
      title: "Document Build complete",
    };
  if (item.state === "canceled")
    return {
      color: "text-[#8a6a21]",
      description: "The build stopped safely before publication.",
      icon: FileX2,
      title: "Document Build canceled",
    };
  return {
    color: "text-[#b24a55]",
    description: "The document could not be completed.",
    icon: FileX2,
    title: "Document Build failed",
  };
};
