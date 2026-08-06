import { AcceptanceReceipt } from "@osfo/api";
import { CommitUnknown } from "@osfo/api/client";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { makeThreadChat } from "./atoms";

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const idempotencyKey = "1429eaac-2f56-4a7e-b78c-ddd58a9d0f99";

const receipt = new AcceptanceReceipt({
  acceptedAt: "2026-08-06T14:32:00.000Z",
  agentRunId: "f3466bd9-26e6-456e-904c-456198b23a57",
  idempotencyKey,
  protocolVersion: 1,
  receiptId: "10fc5bd9-ca92-46aa-bd36-d305157defd2",
  threadId,
  threadPosition: "1",
  userMessageId: "2aa53c48-fdcf-4131-ab5f-7b04cfa8363e",
});

describe("Thread chat atoms", () => {
  it("submits through the API client and appends only the accepted message", () => {
    const commands: Array<unknown> = [];
    const chat = makeThreadChat({
      authenticationToken: "reference-session",
      baseUrl: "https://osfo.test",
      threadId,
      submitMessage: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return receipt;
        }),
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(chat.submit);

    registry.set(chat.submit, { content: "Hello through React", idempotencyKey });

    expect(commands).toEqual([
      {
        authenticationToken: "reference-session",
        baseUrl: "https://osfo.test",
        idempotencyKey,
        message: { content: "Hello through React" },
        threadId,
      },
    ]);
    expect(registry.get(chat.messages)).toEqual([{ content: "Hello through React", receipt }]);
    expect(AsyncResult.isSuccess(registry.get(chat.submit))).toBe(true);

    unmount();
    registry.dispose();
  });

  it("keeps failed submissions out of the accepted transcript", () => {
    const chat = makeThreadChat({
      authenticationToken: "reference-session",
      baseUrl: "https://osfo.test",
      threadId,
      submitMessage: () => Effect.fail(new CommitUnknown()),
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(chat.submit);

    registry.set(chat.submit, { content: "Uncertain message", idempotencyKey });

    expect(registry.get(chat.messages)).toEqual([]);
    expect(AsyncResult.isFailure(registry.get(chat.submit))).toBe(true);

    unmount();
    registry.dispose();
  });

  it("does not duplicate an accepted idempotent retry", () => {
    const chat = makeThreadChat({
      authenticationToken: "reference-session",
      baseUrl: "https://osfo.test",
      threadId,
      submitMessage: () => Effect.succeed(receipt),
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(chat.submit);
    const submission = { content: "Retry me", idempotencyKey };

    registry.set(chat.submit, submission);
    registry.set(chat.submit, submission);

    expect(registry.get(chat.messages)).toEqual([{ content: "Retry me", receipt }]);

    unmount();
    registry.dispose();
  });
});
