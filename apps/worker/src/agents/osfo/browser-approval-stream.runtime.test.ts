/* oxlint-disable effecttsgo/async-function, eslint/no-underscore-dangle -- Native provider callback/async-iterator boundaries and canonical Effect outcomes. */
/* oxlint-disable vitest/no-standalone-expect -- Effect generator assertions. */
import { TextStreamCallback } from "@cloudflare/think/messengers";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { BrowserApprovalResume } from "./browser-approval-resume";
import { appendBrowserApprovalLink, withBrowserApprovalReply } from "./browser-approval-reply";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "delivers the verified browser link through the installed messenger stream before close",
  () =>
    Effect.gen(function* () {
      const provider = new TextStreamCallback();
      const delivered: Array<string> = [];
      const consume = (async () => {
        for await (const chunk of provider.stream()) delivered.push(chunk);
      })();
      const callback = withBrowserApprovalReply(provider, () =>
        appendBrowserApprovalLink({
          text: "",
          webBaseUrl: new URL("https://osfo.test"),
          parts: [
            {
              type: "tool-executeBrowserEffect",
              state: "output-available",
              output: {
                status: "paused",
                action: "executeBrowserEffect",
                executionId: "actpause_test",
              },
            },
          ],
          pending: () =>
            Promise.resolve([
              {
                executionId: "actpause_test",
                source: "action",
                descriptor: {
                  action: "executeBrowserEffect",
                  requestId: "request",
                  toolCallId: "call",
                  input: {},
                  permissions: ["browser:interact"],
                  summary: "Choose Tuesday",
                  kind: "durable-pause",
                },
              },
            ]),
        }),
      );
      yield* Effect.promise(async () => {
        await callback.onStart({ requestId: "request" });
        await callback.onEvent(
          encodeEvent({
            type: "text-delta",
            delta: "Waiting for your decision.",
          }),
        );
        await callback.onDone();
        await consume;
      });
      expect(delivered.join("")).toContain("Waiting for your decision.");
      expect(delivered.join("")).toContain("https://osfo.test/settings/browser");
      expect(provider.hasText()).toBe(true);
    }),
);

it.effect("closes the actual provider stream when approval lookup fails without a false link", () =>
  Effect.gen(function* () {
    const provider = new TextStreamCallback();
    const delivered: Array<string> = [];
    const consume = (async () => {
      for await (const chunk of provider.stream()) delivered.push(chunk);
    })();
    const callback = withBrowserApprovalReply(provider, () =>
      Effect.fail(new BrowserApprovalResume.Unavailable({ cause: "pending unavailable" })),
    );
    yield* Effect.promise(() =>
      Promise.resolve(
        callback.onEvent(
          encodeEvent({
            type: "text-delta",
            delta: "Original reply.",
          }),
        ),
      ),
    );
    const result = yield* Effect.tryPromise({
      try: () => Promise.resolve(callback.onDone()),
      catch: (cause) => new BrowserApprovalResume.Unavailable({ cause }),
    }).pipe(Effect.result);
    yield* Effect.promise(() => consume);
    expect(result._tag).toBe("Failure");
    expect(delivered.join("")).toBe("Original reply.");
  }),
);
