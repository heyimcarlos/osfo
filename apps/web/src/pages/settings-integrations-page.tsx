import type { IntegrationConnectionSummary, IntegrationToolkit } from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import { GlassPanel } from "@osfo/ui/components/glass-panel";
import { Effect } from "effect";
import { CalendarDays, FileText, Mail } from "lucide-react";
import { useEffect, useState } from "react";

import { connectIntegration, disconnectIntegration, inspectIntegrations } from "../lib/api-client";

type Connection = IntegrationConnectionSummary["connections"][number];

/** Authenticated connection lifecycle for the three curated capability packs. */
export function SettingsIntegrationsPage() {
  const [summary, setSummary] = useState<IntegrationConnectionSummary | null>(null);
  const [busyToolkit, setBusyToolkit] = useState<IntegrationToolkit | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    void Effect.runPromise(inspectIntegrations).then(setSummary, () => {
      setError("Integration connections are temporarily unavailable. Please try again.");
    });
  };

  useEffect(refresh, []);

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
    <div>
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
    </div>
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
