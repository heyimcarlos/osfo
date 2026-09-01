import type { ChannelLinksResponse } from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import { GlassPanel } from "@osfo/ui/components/glass-panel";
import { Effect } from "effect";
import { MessageCircle, Send } from "lucide-react";
import { useEffect, useState } from "react";

import { inspectChannelLinks, revokeChannelLink } from "../lib/api-client";

type ActiveLink = ChannelLinksResponse["items"][number];

interface Dependencies {
  readonly confirm: (message: string) => boolean;
  readonly inspect: typeof inspectChannelLinks;
  readonly revoke: typeof revokeChannelLink;
}

const defaultDependencies: Dependencies = {
  confirm: (message) => globalThis.confirm(message),
  inspect: inspectChannelLinks,
  revoke: revokeChannelLink,
};

/** Authenticated inspection and revocation for the User's messaging channels. */
export function SettingsChannelsPage({
  dependencies = defaultDependencies,
}: {
  readonly dependencies?: Dependencies;
}) {
  const [summary, setSummary] = useState<ChannelLinksResponse | null>(null);
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Effect.runPromise(dependencies.inspect).then(
      (links) => {
        if (active) setSummary(links);
      },
      () => {
        if (active) setError("Channel links are temporarily unavailable. Please try again.");
      },
    );
    return () => {
      active = false;
    };
  }, [dependencies]);

  const disconnect = (link: ActiveLink, label: string) => {
    const confirmed = dependencies.confirm(
      `Disconnect ${label} from Osfo? Messages from this account will no longer reach your agent.`,
    );
    if (!confirmed) return;
    setBusyLinkId(link.channelLinkId);
    setError(null);
    void Effect.runPromise(dependencies.revoke(link.channelLinkId)).then(
      () => {
        setBusyLinkId(null);
        setSummary((current) =>
          current === null
            ? current
            : {
                items: current.items.filter(
                  (candidate) => candidate.channelLinkId !== link.channelLinkId,
                ),
              },
        );
      },
      () => {
        setBusyLinkId(null);
        setError("This channel could not be disconnected. Refresh and try again.");
      },
    );
  };

  return (
    <GlassPanel className="p-6">
      <h2 className="text-xl font-bold">Link a messaging channel</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#687896]">
        Send Osfo a private message from the external account you want to link. Osfo replies there
        with a private invitation. Links are never posted in group conversations.
      </p>
      {error === null ? null : (
        <p className="mt-4 rounded-xl bg-[#fff0f2] p-3 text-sm text-[#a82d3f]" role="alert">
          {error}
        </p>
      )}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <ChannelCard
          busyLinkId={busyLinkId}
          color="bg-[#2f8fe8]"
          icon={Send}
          label="Telegram"
          links={summary?.items.filter(({ channel }) => channel === "telegram") ?? []}
          loading={summary === null && error === null}
          onDisconnect={disconnect}
        />
        <ChannelCard
          busyLinkId={busyLinkId}
          color="bg-[#25d366]"
          icon={MessageCircle}
          label="WhatsApp"
          links={summary?.items.filter(({ channel }) => channel === "whatsapp") ?? []}
          loading={summary === null && error === null}
          onDisconnect={disconnect}
        />
      </div>
    </GlassPanel>
  );
}

function ChannelCard({
  busyLinkId,
  color,
  icon: Icon,
  label,
  links,
  loading,
  onDisconnect,
}: {
  readonly busyLinkId: string | null;
  readonly color: string;
  readonly icon: typeof Send;
  readonly label: string;
  readonly links: ReadonlyArray<ActiveLink>;
  readonly loading: boolean;
  readonly onDisconnect: (link: ActiveLink, label: string) => void;
}) {
  return (
    <section className="rounded-2xl border border-white/85 bg-white/72 p-5">
      <div className="flex items-center gap-4">
        <span className={`grid size-12 place-items-center rounded-full text-white ${color}`}>
          <Icon aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-black">{label}</h3>
          <p className="text-sm text-muted-foreground">
            {loading ? "Checking connection..." : links.length > 0 ? "Connected" : "Not connected"}
          </p>
        </div>
      </div>
      {links.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Message Osfo privately from {label}.</p>
      ) : (
        <div className="mt-4 grid gap-2">
          {links.map((link, index) => {
            const accessibleLabel =
              links.length === 1 ? `Disconnect ${label}` : `Disconnect ${label} link ${index + 1}`;
            return (
              <Button
                key={link.channelLinkId}
                aria-label={accessibleLabel}
                disabled={busyLinkId !== null}
                size="sm"
                type="button"
                variant="destructive"
                onClick={() => onDisconnect(link, label)}
              >
                {busyLinkId === link.channelLinkId ? "Disconnecting..." : "Disconnect"}
              </Button>
            );
          })}
        </div>
      )}
    </section>
  );
}
