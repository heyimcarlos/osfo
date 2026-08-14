import { Chat, type ChatMessage } from "@osfo/ui/components/chat";
import { Button } from "@osfo/ui/components/button";
import { useState } from "react";

import { AuthScreen } from "./components/auth-screen";
import { authClient } from "./lib/auth-client";

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

  if (session.isPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background text-sm text-muted-foreground">
        Loading Osfo...
      </main>
    );
  }

  if (!session.data) {
    return (
      <AuthScreen
        onAuthenticated={() => {
          void session.refetch();
        }}
      />
    );
  }

  return <ChatPreview userLabel={session.data.user.email} />;
}

/** Presentation-only chat shown after authentication succeeds. */
export function ChatPreview({ userLabel = "Test user" }: { readonly userLabel?: string }) {
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
