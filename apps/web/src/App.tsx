import { Chat, type ChatMessage } from "@osfo/ui/components/chat";
import { Button, buttonVariants } from "@osfo/ui/components/button";
import type { BillingSummary } from "@osfo/api";
import { Effect } from "effect";
import { lazy, Suspense, useEffect, useState } from "react";

import { AuthScreen } from "./components/auth-screen";
import { BillingScreen } from "./components/billing-screen";
import { HomeScreen } from "./components/home-screen";
import { PlanDetails, PrivacyNotice } from "./components/public-information";
import { authClient } from "./lib/auth-client";
import {
  inspectBilling,
  openBillingPortal,
  reconcileBilling,
  startBillingCheckout,
} from "./lib/api-client";

const GetStartedScreen = lazy(() =>
  import("./components/get-started-screen").then((module) => ({
    default: module.GetStartedScreen,
  })),
);

const initialMessages: ReadonlyArray<ChatMessage> = [
  {
    id: "welcome",
    role: "assistant",
    content: "Hi, I am Osfo. What would you like to work on?",
  },
  {
    id: "example",
    role: "user",
    content: "Help me plan the important parts of my day.",
  },
  {
    id: "reply",
    role: "assistant",
    content:
      "I can help with that. Tell me your fixed commitments and the result you want by the end of the day.",
  },
];

/** Osfo browser composition root. */
export function App() {
  const session = authClient.useSession();
  const pathname = globalThis.location?.pathname ?? "/";
  const invitationToken = /^\/verify\/([^/]+)$/u.exec(pathname)?.[1];
  const isOnboarding = pathname === "/get-started" || invitationToken !== undefined;

  if (pathname === "/privacy") return <PrivacyNotice />;
  if (pathname === "/plans") return <PlanDetails />;

  if (session.isPending) {
    return <LoadingScreen />;
  }

  if (!session.data) {
    if (isOnboarding) {
      return (
        <Suspense fallback={<LoadingScreen />}>
          <GetStartedScreen
            {...(invitationToken === undefined ? {} : { invitationToken })}
            enrollmentProvider="telegram"
            onComplete={() => {
              globalThis.location.assign("/");
            }}
          />
        </Suspense>
      );
    }

    if (pathname === "/") {
      return <HomeScreen />;
    }

    return (
      <AuthScreen
        enableCredentials={import.meta.env.DEV}
        onAuthenticated={() => {
          globalThis.location.assign("/");
        }}
      />
    );
  }

  if (isOnboarding) {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <GetStartedScreen
          {...(invitationToken === undefined ? {} : { invitationToken })}
          enrollmentProvider="telegram"
          isAuthenticated
          onComplete={() => {
            globalThis.location.assign("/");
          }}
        />
      </Suspense>
    );
  }

  if (pathname === "/billing" || pathname === "/billing/return") {
    return <BillingRoute />;
  }

  return <ChatPreview userLabel={presentUserLabel(session.data.user)} />;
}

const BillingRoute = () => {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const search = new URLSearchParams(globalThis.location.search);
    const source = search.get("source");
    const stripeCheckoutSessionId = search.get("session_id");
    if (
      globalThis.location.pathname === "/billing/return" &&
      source === "checkout" &&
      stripeCheckoutSessionId === null
    ) {
      setError("Billing is temporarily unavailable. Please try again.");
      return;
    }
    const load =
      globalThis.location.pathname === "/billing/return" && source === "portal"
        ? reconcileBilling({ reason: "portalReturn" }).pipe(Effect.andThen(inspectBilling))
        : globalThis.location.pathname === "/billing/return" &&
            source === "checkout" &&
            stripeCheckoutSessionId !== null
          ? reconcileBilling({ reason: "checkoutReturn", stripeCheckoutSessionId }).pipe(
              Effect.andThen(inspectBilling),
            )
          : inspectBilling;
    void Effect.runPromise(load).then(setSummary, () => {
      setError("Billing is temporarily unavailable. Please try again.");
    });
  }, []);

  const redirect = (effect: typeof startBillingCheckout) => {
    setBusy(true);
    setError(null);
    void Effect.runPromise(effect).then(
      ({ url }) => {
        globalThis.location.assign(url.href);
      },
      () => {
        setBusy(false);
        setError("Billing is temporarily unavailable. Please try again.");
      },
    );
  };

  if (summary === null) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background p-6 text-center">
        {error ?? "Loading billing..."}
      </main>
    );
  }
  return (
    <>
      {error === null ? null : <p role="alert">{error}</p>}
      <BillingScreen
        busy={busy}
        onCheckout={() => {
          redirect(startBillingCheckout);
        }}
        onPortal={() => {
          redirect(openBillingPortal);
        }}
        summary={summary}
      />
    </>
  );
};

/** Present a User without exposing Better Auth's internal placeholder email. */
const presentUserLabel = (user: {
  readonly name: string;
  readonly phoneNumber?: string | null | undefined;
}) => {
  const name = user.name.trim();
  if (name.length > 0 && name !== "Osfo User" && !name.endsWith(".invalid")) return name;
  if (user.phoneNumber === undefined || user.phoneNumber === null) return "Osfo User";
  const visible = user.phoneNumber.slice(-4);
  return `${"•".repeat(Math.max(4, user.phoneNumber.length - visible.length))}${visible}`;
};

const LoadingScreen = () => (
  <main className="grid min-h-dvh place-items-center bg-background text-sm text-muted-foreground">
    Loading Osfo...
  </main>
);

/** Presentation-only chat shown after authentication succeeds. */
function ChatPreview({ userLabel = "Test user" }: { readonly userLabel?: string }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState(initialMessages);

  const submit = () => {
    const content = draft.trim();
    if (content.length === 0) return;

    setMessages((current) => [
      ...current,
      {
        id: globalThis.crypto.randomUUID(),
        role: "user",
        content,
      },
    ]);
    setDraft("");
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[radial-gradient(circle_at_top,oklch(0.96_0.035_250),oklch(0.985_0.006_250)_42%,oklch(0.965_0.008_250))] sm:p-6">
      <Chat
        className="h-dvh w-full max-w-3xl sm:h-[min(52rem,calc(100dvh-3rem))]"
        description="Reusable chat interface"
        draft={draft}
        messages={messages}
        onDraftChange={setDraft}
        onSubmit={submit}
        placeholder="Message Osfo"
        status={
          <span className="flex items-center gap-2">
            <span className="hidden sm:inline">{userLabel}</span>
            <a className={buttonVariants({ size: "xs", variant: "ghost" })} href="/billing">
              Billing
            </a>
            <Button
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => {
                void authClient.signOut({
                  fetchOptions: {
                    onSuccess: () => globalThis.location.assign("/"),
                  },
                });
              }}
            >
              Sign out
            </Button>
          </span>
        }
        title="Osfo"
      />
    </main>
  );
}
