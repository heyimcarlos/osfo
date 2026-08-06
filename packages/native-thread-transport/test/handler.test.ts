import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
  AcceptanceReceipt,
  MessageAdmission,
  handleNativeThreadRequest,
  submitThreadMessage,
  type SubmitMessageCommand,
} from "../src/index";

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const idempotencyKey = "51b93c36-6a91-45d2-b25e-aaf249dc5208";

const receipt = new AcceptanceReceipt({
  protocolVersion: 1,
  receiptId: "14414c25-1559-4697-9172-15f170101fc1",
  idempotencyKey,
  threadId,
  userMessageId: "53146ff7-2205-44b0-8de4-685509112ac9",
  agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
  threadPosition: "1",
  acceptedAt: "2026-08-06T12:00:00.000Z",
});

const request = (body: unknown, token = "session-token") =>
  new Request(`http://localhost/v1/threads/${threadId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const validBody = {
  protocolVersion: 1,
  idempotencyKey,
  message: { content: "Hello, Oz" },
};

const runHandler = async (
  incoming: Request,
  accept: (command: SubmitMessageCommand) => Effect.Effect<AcceptanceReceipt>,
) => {
  const layer = Layer.succeed(MessageAdmission)(MessageAdmission.of({ accept }));
  return Effect.runPromise(handleNativeThreadRequest(incoming).pipe(Effect.provide(layer)));
};

describe("Native Thread message command", () => {
  it("passes one closed authenticated command to durable admission", async () => {
    let observed: SubmitMessageCommand | undefined;
    const response = await runHandler(request(validBody), (command) => {
      observed = command;
      return Effect.succeed(receipt);
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(receipt);
    expect(observed).toEqual({
      protocolVersion: 1,
      authenticationToken: "session-token",
      threadId,
      idempotencyKey,
      message: { content: "Hello, Oz" },
    });
  });

  it.each([
    ["unknown request field", { ...validBody, unexpected: true }],
    ["unknown nested field", { ...validBody, message: { content: "Hello", extra: true } }],
    ["unsupported version", { ...validBody, protocolVersion: 2 }],
    ["invalid idempotency key", { ...validBody, idempotencyKey: "not-a-uuid" }],
    ["empty message", { ...validBody, message: { content: "" } }],
  ])("rejects %s before admission", async (_label, body) => {
    let called = false;
    const response = await runHandler(request(body), () => {
      called = true;
      return Effect.succeed(receipt);
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      protocolVersion: 1,
      type: "malformed_request",
      title: "Malformed request",
      retryable: false,
    });
    expect(called).toBe(false);
  });
});

describe("Native Thread browser client", () => {
  it("reports a lost successful response body as an unknown commit", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        submitThreadMessage(
          {
            endpoint: `http://localhost/v1/threads/${threadId}/messages`,
            authenticationToken: "session-token",
            threadId,
            idempotencyKey,
            message: { content: "Hello, Oz" },
          },
          async () =>
            ({
              ok: true,
              json: async () => Promise.reject(new SyntaxError("truncated response")),
            }) as unknown as Response,
        ),
      ),
    );

    expect(error._tag).toBe("CommitUnknown");
  });
});
