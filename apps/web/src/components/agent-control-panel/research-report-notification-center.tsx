import type { ResearchReportNotificationSummary } from "@osfo/api";
import { Effect } from "effect";
import { Bell, CheckCircle2, CircleX, Clock3, X } from "lucide-react";
import { useState } from "react";

import { inspectResearchReportNotifications } from "../../lib/api-client";

/** Authenticated safe status projection for delivered Research Report follow-ups. */
export function ResearchReportNotificationCenter() {
  const [items, setItems] = useState<ReadonlyArray<ResearchReportNotificationSummary> | null>(null);
  const [open, setOpen] = useState(false);
  const openCenter = () => {
    setOpen(true);
    if (items !== null) return;
    void Effect.runPromise(inspectResearchReportNotifications).then(
      (notifications) => setItems(notifications.items),
      () => setItems([]),
    );
  };

  return (
    <ResearchReportNotificationCenterContent
      items={items}
      open={open}
      onClose={() => setOpen(false)}
      onOpen={openCenter}
    />
  );
}

/** Pure notification-center presentation for the Agent dashboard. */
export function ResearchReportNotificationCenterContent({
  items,
  onClose,
  onOpen,
  open,
}: {
  readonly items: ReadonlyArray<ResearchReportNotificationSummary> | null;
  readonly onClose: () => void;
  readonly onOpen: () => void;
  readonly open: boolean;
}) {
  const deliveredCount = items?.length ?? 0;
  return (
    <div className="relative">
      <button
        aria-label={`Notification center${deliveredCount === 0 ? "" : `, ${deliveredCount} update${deliveredCount === 1 ? "" : "s"}`}`}
        className="relative grid size-11 place-items-center rounded-full border border-white/80 bg-white/55 text-[#18223f] shadow-[0_8px_20px_rgba(45,68,110,0.12)] transition hover:bg-white/80 focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:ring-offset-2 focus-visible:outline-none"
        type="button"
        onClick={onOpen}
      >
        <Bell aria-hidden="true" className="size-5" />
        {deliveredCount === 0 ? null : (
          <span
            aria-hidden="true"
            className="absolute top-1.5 right-1.5 size-2 rounded-full bg-[#2f7df4] ring-2 ring-white"
          />
        )}
      </button>
      {open ? (
        <section
          aria-label="Notification center"
          aria-modal="true"
          className="absolute top-13 right-0 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-white/85 bg-white/95 p-4 text-left shadow-[0_18px_45px_rgba(45,68,110,0.22)] backdrop-blur-xl"
          role="dialog"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold text-[#101936]">Notifications</h2>
            <button
              aria-label="Close notification center"
              className="grid size-9 place-items-center rounded-full hover:bg-[#edf4ff]"
              type="button"
              onClick={onClose}
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
          {items === null ? (
            <p className="mt-4 text-sm text-[#687896]">Loading Research Report updates...</p>
          ) : items.length === 0 ? (
            <p className="mt-4 text-sm text-[#687896]">No Research Report updates yet.</p>
          ) : (
            <ul className="mt-3 grid max-h-80 gap-2 overflow-auto">
              {items?.map((item) => (
                <NotificationItem item={item} key={`${item.workflowId}:${item.kind}`} />
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

function NotificationItem({ item }: { readonly item: ResearchReportNotificationSummary }) {
  const presentation = notificationPresentation(item);
  const Icon = presentation.icon;
  return (
    <li className="rounded-xl border border-[#dce7f7] bg-[#f7faff] p-3">
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className={`mt-0.5 size-5 shrink-0 ${presentation.color}`} />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#101936]">{presentation.title}</p>
          <p className="mt-1 text-xs text-[#687896]">{presentation.description}</p>
          <p className="mt-2 truncate font-mono text-[0.65rem] text-[#8290aa]">{item.workflowId}</p>
        </div>
      </div>
    </li>
  );
}

const notificationPresentation = (item: ResearchReportNotificationSummary) => {
  if (item.kind === "sourcesCollected")
    return {
      color: "text-[#2f7df4]",
      description: "Public source evidence is committed and the report is still running.",
      icon: Clock3,
      title: "Research Report sources collected",
    };
  if (item.state === "success")
    return {
      color: "text-[#28a969]",
      description:
        item.artifactContentId === null
          ? "The cited report completed."
          : "The cited report artifact is ready.",
      icon: CheckCircle2,
      title: "Research Report complete",
    };
  if (item.state === "canceled")
    return {
      color: "text-[#8a6a21]",
      description: "The report stopped safely before completion.",
      icon: CircleX,
      title: "Research Report canceled",
    };
  return {
    color: "text-[#b24a55]",
    description: "The report could not be completed.",
    icon: CircleX,
    title: "Research Report failed",
  };
};
