import type { ChannelLinksResponse } from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import { GlassPanel } from "@osfo/ui/components/glass-panel";
import { Effect } from "effect";
import { MessageCircle, Send } from "lucide-react";
import { useEffect, useState } from "react";

import { inspectChannelLinks, revokeChannelLink } from "../lib/api-client";

type ActiveLink = ChannelLinksResponse["items"][number];

/** Authenticated inspection and revocation for the User's messaging channels. */
export function SettingsChannelsPage() {
  const [summary, setSummary] = useState<ChannelLinksResponse | null>(null);
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Effect.runPromise(inspectChannelLinks).then(
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
  }, []);

  const disconnect = (link: ActiveLink, description: string) => {
    const confirmed = globalThis.confirm(channelLinkRevocationPrompt(description));
    if (!confirmed) return;
    setBusyLinkId(link.channelLinkId);
    setError(null);
    void Effect.runPromise(revokeChannelLink(link.channelLinkId)).then(
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
    <SettingsChannelsView
      busyLinkId={busyLinkId}
      error={error}
      summary={summary}
      onDisconnect={disconnect}
    />
  );
}

/** Pure rendered state for authenticated Channel Link management. */
export function SettingsChannelsView({
  busyLinkId,
  error,
  onDisconnect,
  summary,
}: {
  readonly busyLinkId: string | null;
  readonly error: string | null;
  readonly onDisconnect: (link: ActiveLink, description: string) => void;
  readonly summary: ChannelLinksResponse | null;
}) {
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
          onDisconnect={onDisconnect}
          unavailable={summary === null && error !== null}
        />
        <ChannelCard
          busyLinkId={busyLinkId}
          color="bg-[#25d366]"
          icon={MessageCircle}
          label="WhatsApp"
          links={summary?.items.filter(({ channel }) => channel === "whatsapp") ?? []}
          loading={summary === null && error === null}
          onDisconnect={onDisconnect}
          unavailable={summary === null && error !== null}
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
  unavailable,
}: {
  readonly busyLinkId: string | null;
  readonly color: string;
  readonly icon: typeof Send;
  readonly label: string;
  readonly links: ReadonlyArray<ActiveLink>;
  readonly loading: boolean;
  readonly onDisconnect: (link: ActiveLink, label: string) => void;
  readonly unavailable: boolean;
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
            {loading
              ? "Checking connection..."
              : unavailable
                ? "Connection unavailable"
                : links.length > 0
                  ? "Connected"
                  : "Not connected"}
          </p>
        </div>
      </div>
      {unavailable ? null : links.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Message Osfo privately from {label}.</p>
      ) : (
        <div className="mt-4 grid gap-2">
          {links.map((link) => {
            const description = linkDescription(label, link);
            return (
              <div className="flex items-center justify-between gap-3" key={link.channelLinkId}>
                <p className="min-w-0 text-sm text-muted-foreground">{description}</p>
                <Button
                  aria-label={`Disconnect ${description}`}
                  disabled={busyLinkId !== null}
                  size="sm"
                  type="button"
                  variant="destructive"
                  onClick={() => onDisconnect(link, description)}
                >
                  {busyLinkId === link.channelLinkId ? "Disconnecting..." : "Disconnect"}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const linkDescription = (label: string, link: ActiveLink) =>
  `${label} link …${link.channelLinkId.slice(-8)}, connected ${link.linkedAt.toISOString().slice(0, 10)}`;

/** Exact destructive confirmation copy for one owner-safe Channel Link description. */
export const channelLinkRevocationPrompt = (description: string) =>
  `Disconnect ${description} from Osfo? Messages from this account will no longer reach your agent.`;
