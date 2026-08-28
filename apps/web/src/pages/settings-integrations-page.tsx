import type {
  IntegrationConnectionSummary,
  IntegrationToolkit,
  ScheduledEmailApproval,
  ScheduledEmailNotificationSummary,
} from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import { GlassPanel } from "@osfo/ui/components/glass-panel";
import { Effect } from "effect";
import { CalendarDays, FileText, Mail } from "lucide-react";
import { useEffect, useState } from "react";

import {
  connectIntegration,
  decideScheduledEmailApproval,
  disconnectIntegration,
  inspectIntegrations,
  inspectScheduledEmailApprovals,
  inspectScheduledEmailNotifications,
} from "../lib/api-client";

type Connection = IntegrationConnectionSummary["connections"][number];

/** Authenticated connection lifecycle for the three curated capability packs. */
export function SettingsIntegrationsPage() {
  const [summary, setSummary] = useState<IntegrationConnectionSummary | null>(null);
  const [busyToolkit, setBusyToolkit] = useState<IntegrationToolkit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scheduledEmail, setScheduledEmail] = useState<{
    readonly approvals: ReadonlyArray<ScheduledEmailApproval>;
    readonly notifications: ReadonlyArray<ScheduledEmailNotificationSummary>;
  } | null>(null);
  const [scheduledEmailBusy, setScheduledEmailBusy] = useState<string | null>(null);
  const [scheduledEmailError, setScheduledEmailError] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    void Effect.runPromise(inspectIntegrations).then(setSummary, () => {
      setError("Integration connections are temporarily unavailable. Please try again.");
    });
  };

  useEffect(refresh, []);

  const refreshScheduledEmail = () => {
    setScheduledEmailError(null);
    void Promise.all([
      Effect.runPromise(inspectScheduledEmailApprovals),
      Effect.runPromise(inspectScheduledEmailNotifications),
    ]).then(
      ([approvals, notifications]) =>
        setScheduledEmail({ approvals: approvals.items, notifications: notifications.items }),
      () => setScheduledEmailError("Scheduled Email status is temporarily unavailable."),
    );
  };

  useEffect(refreshScheduledEmail, []);

  const connect = (toolkit: IntegrationToolkit) => {
    setBusyToolkit(toolkit);
    setError(null);
    void Effect.runPromise(connectIntegration(toolkit)).then(
      ({ url }) => globalThis.location.assign(url.href),
      () => {
        setBusyToolkit(null);
        setError("The secure connection link is temporarily unavailable. Please try again.");
      },
    );
  };

  const disconnect = (toolkit: IntegrationToolkit) => {
    if (!globalThis.confirm("Disconnect this account from Osfo?")) return;
    setBusyToolkit(toolkit);
    setError(null);
    void Effect.runPromise(disconnectIntegration(toolkit)).then(
      () => {
        setBusyToolkit(null);
        refresh();
      },
      () => {
        setBusyToolkit(null);
        setError("The connection could not be disconnected. Please try again.");
      },
    );
  };

  if (summary === null) {
    return (
      <div className="grid min-h-64 place-items-center text-center">
        {error ?? "Loading integrations..."}
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      {error === null ? null : (
        <p className="mb-4 rounded-xl bg-[#fff0f2] p-3 text-sm text-[#a82d3f]" role="alert">
          {error}
        </p>
      )}
      <SettingsIntegrationsContent
        busyToolkit={busyToolkit}
        connections={summary.connections}
        onConnect={connect}
        onDisconnect={disconnect}
        onRefresh={refresh}
      />
      <ScheduledEmailControlContent
        busyPresentationId={scheduledEmailBusy}
        error={scheduledEmailError}
        items={scheduledEmail}
        onDecide={(presentationId, decision) => {
          setScheduledEmailBusy(presentationId);
          setScheduledEmailError(null);
          void Effect.runPromise(decideScheduledEmailApproval({ decision, presentationId })).then(
            () => {
              setScheduledEmailBusy(null);
              refreshScheduledEmail();
            },
            () => {
              setScheduledEmailBusy(null);
              setScheduledEmailError("The exact Approval decision could not be recorded.");
            },
          );
        }}
        onRefresh={refreshScheduledEmail}
      />
    </div>
  );
}

/** Exact pending decision and safe delivered outcome projection for Scheduled Email. */
export function ScheduledEmailControlContent({
  busyPresentationId,
  error,
  items,
  onDecide,
  onRefresh,
}: {
  readonly busyPresentationId: string | null;
  readonly error: string | null;
  readonly items: {
    readonly approvals: ReadonlyArray<ScheduledEmailApproval>;
    readonly notifications: ReadonlyArray<ScheduledEmailNotificationSummary>;
  } | null;
  readonly onDecide: (presentationId: string, decision: "approve" | "reject") => void;
  readonly onRefresh: () => void;
}) {
  return (
    <GlassPanel className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Scheduled Emails</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#687896]">
            Review the exact recipient, subject, body, Gmail resource, and scheduled instant before
            Osfo accepts a future send.
          </p>
        </div>
        <Button size="sm" type="button" variant="secondary" onClick={onRefresh}>
          Refresh Scheduled Emails
        </Button>
      </div>
      {error === null ? null : (
        <p className="mt-4 rounded-xl bg-[#fff0f2] p-3 text-sm text-[#a82d3f]" role="alert">
          {error}
        </p>
      )}
      {items === null ? (
        <p className="mt-4 text-sm text-[#687896]">Loading Scheduled Emails...</p>
      ) : (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <section aria-label="Pending Scheduled Email Approvals">
            <h3 className="font-bold">Pending Approval</h3>
            {items.approvals.length === 0 ? (
              <p className="mt-3 text-sm text-[#687896]">No Scheduled Email awaits Approval.</p>
            ) : (
              <ul className="mt-3 grid gap-3">
                {items.approvals.map((approval) => (
                  <li
                    className="rounded-2xl border border-[#dce7f7] bg-[#f7faff] p-4"
                    key={approval.presentationId}
                  >
                    <p className="font-semibold text-[#101936]">{approval.title}</p>
                    <p className="mt-1 text-sm text-[#687896]">{approval.description}</p>
                    <dl className="mt-3 grid gap-2 text-sm">
                      {approval.fields.map((field) => (
                        <div key={field.name}>
                          <dt className="font-semibold text-[#41506c]">{field.label}</dt>
                          <dd className="whitespace-pre-wrap break-words text-[#101936]">
                            {field.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-3 text-sm font-medium text-[#7b4d1d]">
                      {approval.consequences.join(" ")}
                    </p>
                    <div className="mt-4 flex gap-2">
                      <Button
                        disabled={busyPresentationId !== null}
                        type="button"
                        onClick={() => onDecide(approval.presentationId, "approve")}
                      >
                        Approve exact Scheduled Email
                      </Button>
                      <Button
                        disabled={busyPresentationId !== null}
                        type="button"
                        variant="secondary"
                        onClick={() => onDecide(approval.presentationId, "reject")}
                      >
                        Reject
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Scheduled Email outcomes">
            <h3 className="font-bold">Delivered status</h3>
            {items.notifications.length === 0 ? (
              <p className="mt-3 text-sm text-[#687896]">No terminal Scheduled Email update yet.</p>
            ) : (
              <ul className="mt-3 grid gap-3">
                {items.notifications.map((notification) => (
                  <li
                    className="rounded-2xl border border-[#dce7f7] bg-[#f7faff] p-4"
                    key={notification.workflowId}
                  >
                    <p className="font-semibold text-[#101936]">
                      {notification.state === "success"
                        ? "Scheduled Email sent"
                        : notification.state === "canceled"
                          ? "Scheduled Email canceled"
                          : "Scheduled Email failed"}
                    </p>
                    <p className="mt-1 break-all text-xs text-[#687896]">
                      Workflow: {notification.workflowId}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </GlassPanel>
  );
}

/** Safe provider-neutral connection cards; provider account IDs never reach this surface. */
export function SettingsIntegrationsContent({
  busyToolkit,
  connections,
  onConnect,
  onDisconnect,
  onRefresh,
}: {
  readonly busyToolkit: IntegrationToolkit | null;
  readonly connections: ReadonlyArray<Connection>;
  readonly onConnect: (toolkit: IntegrationToolkit) => void;
  readonly onDisconnect: (toolkit: IntegrationToolkit) => void;
  readonly onRefresh: () => void;
}) {
  return (
    <GlassPanel className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Connected services</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#687896]">
            Osfo reads only when you ask. Sending email, changing events, or delivering a document
            still requires your approval of the exact action.
          </p>
        </div>
        <Button size="sm" type="button" variant="secondary" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {connections.map((connection) => (
          <ConnectionCard
            busy={busyToolkit === connection.toolkit}
            connection={connection}
            key={connection.toolkit}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
          />
        ))}
      </div>
    </GlassPanel>
  );
}

const ConnectionCard = ({
  busy,
  connection,
  onConnect,
  onDisconnect,
}: {
  readonly busy: boolean;
  readonly connection: Connection;
  readonly onConnect: (toolkit: IntegrationToolkit) => void;
  readonly onDisconnect: (toolkit: IntegrationToolkit) => void;
}) => {
  const Icon = iconFor(connection.toolkit);
  const canDisconnect = connection.status === "connected" || connection.status === "stale";
  return (
    <section className="flex min-h-64 flex-col rounded-2xl border border-white/85 bg-white/72 p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-full bg-[#e3efff] text-[#1767d9]">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <div>
          <h3 className="font-bold">{connection.label}</h3>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#687896]">
            {statusLabel(connection.status)}
          </p>
        </div>
      </div>
      <p className="mt-4 text-sm leading-relaxed text-[#687896]">{connection.description}</p>
      <div className="mt-auto pt-5">
        {connection.status === "unavailable" ? (
          <Button className="w-full" disabled type="button" variant="secondary">
            Unavailable here
          </Button>
        ) : canDisconnect ? (
          <div className="grid gap-2">
            {connection.status === "stale" ? (
              <Button disabled={busy} type="button" onClick={() => onConnect(connection.toolkit)}>
                Reconnect
              </Button>
            ) : null}
            <Button
              disabled={busy}
              type="button"
              variant="secondary"
              onClick={() => onDisconnect(connection.toolkit)}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <Button
            className="w-full"
            disabled={busy}
            type="button"
            onClick={() => onConnect(connection.toolkit)}
          >
            Connect
          </Button>
        )}
      </div>
    </section>
  );
};

const iconFor = (toolkit: IntegrationToolkit) => {
  if (toolkit === "gmail") return Mail;
  if (toolkit === "googlecalendar") return CalendarDays;
  return FileText;
};

const statusLabel = (status: Connection["status"]) => {
  if (status === "connected") return "Connected";
  if (status === "missing") return "Not connected";
  if (status === "stale") return "Needs attention";
  return "Unavailable";
};
