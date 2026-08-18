import { useAgentChat } from "@cloudflare/think/react";
import { Chat, type ChatMessage } from "@osfo/ui/components/chat";
import { Button } from "@osfo/ui/components/button";
import { Link, useRouter } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { useState } from "react";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";

import { useAuthState } from "../auth-state";
import { authClient } from "../lib/auth-client";
import { type AgentConnection, useAgentConnection } from "../lib/agent-connection";
import { presentUserLabel } from "../lib/user-label";

/* oxlint-disable eslint/no-underscore-dangle -- Typed connection state uses the standard _tag discriminator. */

/** Route-owned Think conversation page backed by the server-authoritative Session tree. */
export function ThinkPage() {
  const connection = useAgentConnection();
  if (connection._tag === "InvalidConfiguration") {
    return (
      <section className="grid min-h-dvh place-items-center p-6">
        <p role="alert">Osfo cannot start because its Agent connection is not configured.</p>
      </section>
    );
  }
  return <ConnectedThinkPage connection={connection.connection} />;
}

function ConnectedThinkPage({ connection }: { readonly connection: AgentConnection }) {
  const session = useAuthState();
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const agent = useAgent({
    agent: "OsfoAgent",
    basePath: "agent",
    host: connection.host,
    protocol: connection.protocol,
  });
  const { connectionError, isRecovering, isServerStreaming, isStreaming, messages, sendMessage } =
    useAgentChat({ agent });
  const chatMessages = Array.isArray(messages) ? messages.flatMap(toChatMessage) : [];
  const isSubmitting = isStreaming || isServerStreaming;
  const userLabel = session.data === null ? "Osfo User" : presentUserLabel(session.data.user);
  const submit = () => {
    const content = draft.trim();
    if (content.length === 0 || isSubmitting) return;
    void sendMessage({ text: content });
    setDraft("");
  };
  const description =
    connectionError === null
      ? isRecovering
        ? "Osfo is recovering your current turn."
        : "Your private Osfo conversation"
      : "Osfo could not connect. Check your connection and try again.";

  return (
    <section className="flex min-h-dvh items-center justify-center p-0 md:min-h-[calc(100dvh-2.5rem)] md:p-6">
      <Chat
        className="h-dvh w-full max-w-4xl border-0 shadow-none md:h-[min(54rem,calc(100dvh-5.5rem))] md:border-2 md:shadow-[8px_8px_0_var(--foreground)]"
        description={description}
        draft={draft}
        isSubmitting={isSubmitting}
        messages={chatMessages}
        onDraftChange={setDraft}
        onSubmit={submit}
        placeholder="Message Osfo"
        status={
          <span className="flex items-center gap-2">
            <span className="hidden sm:inline">{userLabel}</span>
            <Link
              aria-label="Open settings"
              className="grid size-8 place-items-center rounded-lg hover:bg-accent"
              to="/settings"
            >
              <Settings className="size-4" aria-hidden="true" />
            </Link>
            <Button
              size="xs"
              type="button"
              variant="ghost"
              onClick={() =>
                void authClient.signOut({
                  fetchOptions: { onSuccess: () => void router.navigate({ to: "/" }) },
                })
              }
            >
              Sign out
            </Button>
          </span>
        }
        title="Think"
      />
    </section>
  );
}

const toChatMessage = (message: UIMessage): ReadonlyArray<ChatMessage> => {
  if (message.role !== "assistant" && message.role !== "user") return [];
  const content = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  if (content.length === 0) return [];
  return [{ content, id: message.id, role: message.role }];
};
