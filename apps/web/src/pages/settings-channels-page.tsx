import type { ChannelEnrollmentResponse, ChannelProvider } from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import { Effect, Exit } from "effect";
import { ExternalLink, MessageCircle, Send } from "lucide-react";
import { useState } from "react";

import { startChannelEnrollment } from "../lib/api-client";

/* oxlint-disable eslint/no-underscore-dangle -- Typed page states use the standard _tag discriminator. */

/** Browser operation used to start an explicit channel connection. */
export interface SettingsChannelsPageDependencies {
  readonly startEnrollment: typeof startChannelEnrollment;
}

/** Optional dependency override for channel settings tests. */
export interface SettingsChannelsPageProps {
  readonly dependencies?: SettingsChannelsPageDependencies;
}

type EnrollmentState =
  | { readonly _tag: "Failed"; readonly provider: ChannelProvider }
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Ready"; readonly enrollment: ChannelEnrollmentResponse }
  | { readonly _tag: "Starting"; readonly provider: ChannelProvider };

/** Route-owned controls for explicit messaging channel connections. */
export function SettingsChannelsPage({
  dependencies = defaultDependencies,
}: SettingsChannelsPageProps = {}) {
  const [state, setState] = useState<EnrollmentState>({ _tag: "Idle" });
  const start = (provider: ChannelProvider) => {
    setState({ _tag: "Starting", provider });
    void Effect.runPromiseExit(dependencies.startEnrollment(provider)).then((exit) => {
      setState(
        Exit.isFailure(exit)
          ? { _tag: "Failed", provider }
          : { _tag: "Ready", enrollment: exit.value },
      );
    });
  };

  return (
    <div className="rounded-[1.5rem] border border-white/85 bg-white/68 p-6 shadow-[0_14px_36px_rgba(63,88,124,0.11)]">
      <h2 className="text-xl font-bold">Connect a messaging channel</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#687896]">
        Choose a channel, then send the prepared message from that account. Osfo connects it after
        the messaging provider confirms your identity.
      </p>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <ChannelCard
          color="bg-[#2f8fe8]"
          icon={Send}
          label="Telegram"
          provider="telegram"
          state={state}
          onStart={start}
        />
        <ChannelCard
          color="bg-[#25d366]"
          icon={MessageCircle}
          label="WhatsApp"
          provider="whatsapp"
          state={state}
          onStart={start}
        />
      </div>
    </div>
  );
}

const defaultDependencies: SettingsChannelsPageDependencies = {
  startEnrollment: startChannelEnrollment,
};

function ChannelCard({
  color,
  icon: Icon,
  label,
  onStart,
  provider,
  state,
}: {
  readonly color: string;
  readonly icon: typeof Send;
  readonly label: string;
  readonly onStart: (provider: ChannelProvider) => void;
  readonly provider: ChannelProvider;
  readonly state: EnrollmentState;
}) {
  const isStarting = state._tag === "Starting" && state.provider === provider;
  const failed = state._tag === "Failed" && state.provider === provider;
  const enrollment =
    state._tag === "Ready" && state.enrollment.provider === provider ? state.enrollment : null;

  return (
    <section className="rounded-2xl border border-white/85 bg-white/72 p-5">
      <div className="flex items-center gap-4">
        <span className={`grid size-12 place-items-center rounded-full text-white ${color}`}>
          <Icon aria-hidden="true" />
        </span>
        <div>
          <h3 className="text-lg font-black">{label}</h3>
          <p className="text-sm text-muted-foreground">Connect your {label} account</p>
        </div>
      </div>
      <div className="mt-5">
        {enrollment === null ? (
          <Button disabled={isStarting} type="button" onClick={() => onStart(provider)}>
            {isStarting ? `Preparing ${label}...` : `Connect ${label}`}
          </Button>
        ) : (
          <a
            className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground hover:bg-primary/80"
            href={enrollment.enrollmentUrl.href}
          >
            Open {label}
            <ExternalLink aria-hidden="true" className="size-4" />
          </a>
        )}
        {failed ? (
          <p className="mt-3 text-sm font-medium text-destructive" role="alert">
            Osfo could not prepare this connection. Try again.
          </p>
        ) : null}
      </div>
    </section>
  );
}
