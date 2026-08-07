import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import {
  AgentRunCancellation,
  AgentRunCancellationReceipt,
  MessageAdmission,
  ThreadResume,
  ThreadStreamLifecycle,
  type AgentRunCancellationService,
  type MessageAdmissionError,
  type SubmitMessageCommand,
  type ThreadResumeService,
} from "../src/index.js";
import { OsfoApiLive } from "../src/server.js";
import { makeTestThreadStreamLifecycle } from "./thread-stream-lifecycle-harness.js";

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const agentRunId = "96ae49eb-b1ab-41cb-a468-b68893ec82c3";

describe("AgentRun cancellation API", () => {
  it("authenticates and routes one versioned cancellation command", async () => {
    const requests: Array<unknown> = [];
    const cancellation = AgentRunCancellation.of({
      cancel: (command) =>
        Effect.sync(() => {
          requests.push(command);
          return new AgentRunCancellationReceipt({
            protocolVersion: 1 as const,
            agentRunId,
            outcome: "cancellationRequested" as const,
          });
        }),
    } satisfies AgentRunCancellationService);
    const admission = MessageAdmission.of({
      accept: (_command: SubmitMessageCommand): Effect.Effect<never, MessageAdmissionError> =>
        Effect.never,
      reconcile: () => Effect.never,
      reconcileCapacity: () => Effect.never,
    });
    const resume = ThreadResume.of({
      snapshot: (): ReturnType<ThreadResumeService["snapshot"]> => Effect.never,
      history: (): ReturnType<ThreadResumeService["history"]> => Effect.never,
      stream: (): ReturnType<ThreadResumeService["stream"]> => Effect.never,
    });
    const testLifecycle = makeTestThreadStreamLifecycle(1);
    const lifecycle = testLifecycle.lifecycle;
    const web = HttpRouter.toWebHandler(
      OsfoApiLive.pipe(
        Layer.provide(Layer.succeed(AgentRunCancellation)(cancellation)),
        Layer.provide(Layer.succeed(MessageAdmission)(admission)),
        Layer.provide(Layer.succeed(ThreadResume)(resume)),
        Layer.provide(Layer.succeed(ThreadStreamLifecycle)(lifecycle)),
        Layer.provideMerge(HttpServer.layerServices),
      ),
    );
    const context = Context.make(AgentRunCancellation, cancellation).pipe(
      Context.add(MessageAdmission, admission),
      Context.add(ThreadResume, resume),
      Context.add(ThreadStreamLifecycle, lifecycle),
    );

    try {
      const response = await web.handler(
        new Request(
          `http://osfo.test/v1/threads/${threadId}/agent-runs/${agentRunId}/cancellation`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer reference-session",
              "content-type": "application/json",
            },
            body: JSON.stringify({ protocolVersion: 1 }),
          },
        ),
        context,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        protocolVersion: 1,
        agentRunId,
        outcome: "cancellationRequested",
      });
      expect(requests).toEqual([
        {
          protocolVersion: 1,
          authenticationToken: "reference-session",
          threadId,
          agentRunId,
        },
      ]);
    } finally {
      await web.dispose();
      await testLifecycle.dispose();
    }
  });
});
