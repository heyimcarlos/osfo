import { Button } from "@osfo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@osfo/ui/components/card";
import { PageStatusCard } from "@osfo/ui/components/page-status-card";
import { useParams, useRouter } from "@tanstack/react-router";
import { Effect, Exit } from "effect";
import { useEffect, useState } from "react";

import { useAuthState } from "../auth-state";
import { AuthScreen } from "../components/auth-screen";
import { acceptChannelLinkInvite, inspectChannelLinkInvite } from "../lib/api-client";

/** Browser operations used by the Channel Link Invite page. */
export interface ChannelLinkPageDependencies {
  readonly accept: typeof acceptChannelLinkInvite;
  readonly inspect: typeof inspectChannelLinkInvite;
}

interface ChannelLinkPageProps {
  readonly dependencies?: ChannelLinkPageDependencies;
  readonly token: string;
}

type PageState = "accepting" | "checking" | "complete" | "failed" | "ready" | "unavailable";

/** Inspect and accept one private Channel Link Invite without displaying provider identifiers. */
export function ChannelLinkPage({
  dependencies = defaultDependencies,
  token,
}: ChannelLinkPageProps) {
  const auth = useAuthState();
  const router = useRouter();
  const [state, setState] = useState<PageState>("checking");

  useEffect(() => {
    let active = true;
    void Effect.runPromiseExit(dependencies.inspect(token)).then((exit) => {
      if (!active) return;
      setState(Exit.isSuccess(exit) && exit.value.state === "pending" ? "ready" : "unavailable");
    });
    return () => {
      active = false;
    };
  }, [dependencies, token]);

  if (state === "checking" || auth.isPending) {
    return (
      <PageStatusCard
        description="Checking the private invitation."
        role="status"
        title="Checking your link"
      />
    );
  }
  if (state === "unavailable") {
    return (
      <PageStatusCard
        description="Request a fresh link in your private chat with Osfo."
        role="alert"
        title="This link is unavailable"
      />
    );
  }
  if (state === "complete") {
    return (
      <PageStatusCard
        description="New messages from this address can now act with your Osfo identity."
        role="status"
        title="Channel linked"
      />
    );
  }
  if (auth.data === null) {
    return (
      <div className="space-y-8">
        <InvitationCard />
        <AuthScreen onAuthenticated={() => void auth.refreshFromAuthority()} />
      </div>
    );
  }
  if (auth.data.user.registrationCompletedAt == null) {
    return (
      <InvitationCard>
        <Button
          className="w-full"
          type="button"
          onClick={() =>
            void router.navigate({
              search: { returnTo: `/verify/${token}` },
              to: "/get-started",
            })
          }
        >
          Complete User Registration
        </Button>
        <p className="text-sm text-foreground/70">
          This invitation remains available while you finish registration.
        </p>
      </InvitationCard>
    );
  }
  if (state === "failed") {
    return (
      <PageStatusCard
        description="The channel was not linked. Request a new invitation if this link was already used."
        role="alert"
        title="Linking failed"
      />
    );
  }

  return (
    <InvitationCard>
      <Button
        className="w-full"
        disabled={state === "accepting"}
        type="button"
        onClick={() => {
          setState("accepting");
          void Effect.runPromiseExit(dependencies.accept(token)).then((exit) => {
            setState(Exit.isSuccess(exit) ? "complete" : "failed");
          });
        }}
      >
        {state === "accepting" ? "Linking channel..." : "Link this channel"}
      </Button>
    </InvitationCard>
  );
}

function InvitationCard({ children }: { readonly children?: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Link a messaging channel</CardTitle>
          <CardDescription>
            This private invitation will let messages from one external address act with your Osfo
            User identity. It will not merge conversation history.
          </CardDescription>
        </CardHeader>
        {children === undefined ? null : (
          <CardContent className="space-y-4">{children}</CardContent>
        )}
      </Card>
    </main>
  );
}

/** TanStack Router adapter for Channel Link Invite URLs. */
export function ChannelLinkRoute() {
  const { token } = useParams({ from: "/verify/$token" });
  return <ChannelLinkPage token={token} />;
}

const defaultDependencies: ChannelLinkPageDependencies = {
  accept: acceptChannelLinkInvite,
  inspect: inspectChannelLinkInvite,
};
