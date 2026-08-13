import { describe, expect, it } from "@effect/vitest";
import { Chat } from "@osfo/ui/components/chat";
import { renderToStaticMarkup } from "react-dom/server";

describe("Chat", () => {
  it("renders messages through its presentation interface", () => {
    const html = renderToStaticMarkup(
      <Chat
        draft=""
        messages={[
          { id: "assistant-1", role: "assistant", content: "How can I help?" },
          { id: "user-1", role: "user", content: "Plan my day." },
        ]}
        onDraftChange={() => undefined}
        onSubmit={() => undefined}
        status="Ready"
        title="Chat"
      />,
    );

    expect(html).toContain('data-slot="chat"');
    expect(html).toContain("How can I help?");
    expect(html).toContain('placeholder="Write a message"');
    expect(html).toContain("Plan my day.");
    expect(html).toContain("Ready");
  });
});
