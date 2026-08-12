import { Chat, type ChatMessage } from "@osfo/ui/components/chat";
import { useRef, useState } from "react";

const initialMessages: ReadonlyArray<ChatMessage> = [
  {
    id: "welcome",
    role: "assistant",
    content: "Hi, I am Oz. What would you like to work on?",
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

export function App() {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState(initialMessages);
  const nextMessageId = useRef(initialMessages.length);

  const submit = () => {
    const content = draft.trim();
    if (content.length === 0) return;

    const id = `preview-${nextMessageId.current}`;
    nextMessageId.current += 1;
    setMessages((current) => [
      ...current,
      {
        id,
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
        status="UI preview"
        title="Oz"
      />
    </main>
  );
}
