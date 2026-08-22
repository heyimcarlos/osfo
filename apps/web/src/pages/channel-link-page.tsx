import { Button } from "@osfo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@osfo/ui/components/card";
import { PageStatusCard } from "@osfo/ui/components/page-status-card";
import { useParams } from "@tanstack/react-router";
import { Effect, Exit } from "effect";
import { useEffect, useState } from "react";

import { useAuthState } from "../auth-state";
import { AuthScreen } from "../components/auth-screen";
import { browserRegistrationLocale } from "../components/registration-layout";
import {
  acceptChannelLinkInvite,
  completeRegistration,
  inspectChannelLinkInvite,
} from "../lib/api-client";

/** Browser operations used by the Channel Link Invite page. */
export interface ChannelLinkPageDependencies {
  readonly accept: typeof acceptChannelLinkInvite;
  readonly completeRegistration: typeof completeRegistration;
  readonly inspect: typeof inspectChannelLinkInvite;
}

interface ChannelLinkPageProps {
  readonly dependencies?: ChannelLinkPageDependencies;
  readonly token: string;
}

type PageState =
  | "accepting"
  | "checking"
  | "complete"
  | "failed"
  | "ready"
  | "registering"
  | "registration-failed"
  | "unavailable";

/** Inspect and accept one private Channel Link Invite without displaying provider identifiers. */
export function ChannelLinkPage({
  dependencies = defaultDependencies,
  token,
}: ChannelLinkPageProps) {
  const auth = useAuthState();
  const [registrationCompleted, setRegistrationCompleted] = useState(false);
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

  useEffect(() => {
    if (
      state !== "ready" ||
      auth.data === null ||
      auth.data.user.registrationCompletedAt != null ||
      registrationCompleted
    ) {
      return undefined;
    }
    setState("registering");
    return undefined;
  }, [auth.data, registrationCompleted, state]);

  useEffect(() => {
    if (state !== "registering") return undefined;
    let active = true;
    void Effect.runPromiseExit(
      dependencies.completeRegistration({
        helpAreas: [],
        locale: browserRegistrationLocale(),
        preferredName: null,
      }),
    ).then((exit) => {
      if (!active) return;
      if (Exit.isFailure(exit)) {
        setState("registration-failed");
        return;
      }
      setRegistrationCompleted(true);
      setState("ready");
      void auth.refreshFromAuthority().catch(() => undefined);
    });
    return () => {
      active = false;
    };
  }, [auth, dependencies, state]);

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
  if (
    state === "registering" ||
    (state === "ready" &&
      auth.data !== null &&
      auth.data.user.registrationCompletedAt == null &&
      !registrationCompleted)
  ) {
    return (
      <PageStatusCard
        description="Preparing your Osfo account after phone verification."
        role="status"
        title="Finishing registration"
      />
    );
  }
  if (state === "registration-failed") {
    return (
      <PageStatusCard
        description="Registration could not be completed. Refresh this page to try again."
        role="alert"
        title="Registration unavailable"
      />
    );
  }
  if (auth.data === null) {
    return <AuthScreen smsOnly onAuthenticated={() => void auth.refreshFromAuthority()} />;
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
    <ChannelLinkConfirmation>
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
    </ChannelLinkConfirmation>
  );
}

function ChannelLinkConfirmation({ children }: { readonly children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Connect this chat</CardTitle>
          <CardDescription>
            Confirm that this private chat can use your Osfo identity.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
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
  completeRegistration,
  inspect: inspectChannelLinkInvite,
};
