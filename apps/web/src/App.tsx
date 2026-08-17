import { Chat, type ChatMessage } from "@osfo/ui/components/chat";
import { Button } from "@osfo/ui/components/button";
import { lazy, Suspense, useState } from "react";

import { AuthScreen } from "./components/auth-screen";
import { PlanDetails, PrivacyNotice } from "./components/public-information";
import { authClient } from "./lib/auth-client";

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
            onComplete={() => {
              globalThis.location.assign("/");
            }}
          />
        </Suspense>
      );
    }

    return (
      <AuthScreen
        onAuthenticated={() => {
          void session.refetch();
        }}
      />
    );
  }

  if (isOnboarding) {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <GetStartedScreen
          {...(invitationToken === undefined ? {} : { invitationToken })}
          isAuthenticated
          onComplete={() => {
            globalThis.location.assign("/");
          }}
        />
      </Suspense>
    );
  }

  return <ChatPreview userLabel={presentUserLabel(session.data.user)} />;
}

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
            <Button
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => {
                void authClient.signOut();
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
