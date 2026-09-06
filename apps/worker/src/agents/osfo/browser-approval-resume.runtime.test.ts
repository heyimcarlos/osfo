/* oxlint-disable eslint/no-underscore-dangle -- Canonical Effect outcomes. */
/* oxlint-disable effecttsgo/async-function -- Cloudflare callbacks and test native storage boundaries. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions are inside Effect generators. */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { OsfoAgent } from "./agent";
import { BrowserApprovalResume } from "./browser-approval-resume";
import { AgentStorageErasure } from "./agent-storage-erasure";

it.effect(
  "retains an immutable pause origin, distinguishes uncertain resolution, prunes completed work, and erases private records",
  () =>
    Effect.promise(async () => {
      // SAFETY: the focused Wrangler config binds this namespace to OsfoAgent.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Generated production Env does not include the test namespace.
      const runtime = env as typeof env & {
        readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
      };
      await runInDurableObject(
        runtime.OSFO_AGENT_TEST.getByName("browser-approval-origin"),
        async (_agent, state) => {
          await Effect.runPromise(
            Effect.gen(function* () {
              const store = BrowserApprovalResume.make(state.storage);
              const origin = yield* Schema.decodeEffect(BrowserApprovalResume.Origin)({
                actionId: "action",
                channelLinkId: "channel",
                routeId: "route",
                sessionId: "session",
                submissionId: "submission",
                userId: "owner",
                messenger: {
                  messengerId: "telegram",
                  provider: "telegram",
                  capabilities: {},
                  kind: "direct-message",
                  thread: {
                    id: "telegram:author",
                    providerThreadId: "author",
                    isDirectMessage: true,
                  },
                  message: {
                    id: "message",
                    providerMessageId: "message",
                    author: { userId: "author" },
                    text: "Book within my preferences",
                    attachments: [],
                  },
                },
                input: {
                  taskId: "task",
                  observationId: "observation",
                  expectedUrl: "https://portal.example/book",
                  targetDescription: "9 button Choose Tuesday",
                  interaction: { _tag: "Click", target: "9" },
                  consequence: "Select Tuesday.",
                },
              });
              yield* store.retainOrigin(origin);
              expect(yield* store.origin(origin.actionId)).toEqual(origin);
              const changed = yield* store
                .retainOrigin({
                  ...origin,
                  messenger: {
                    ...origin.messenger,
                    thread: { ...origin.messenger.thread, id: "telegram:other" },
                  },
                })
                .pipe(Effect.result);
              expect(changed._tag).toBe("Failure");
              const uncertain = yield* Schema.decodeEffect(BrowserApprovalResume.Decision)({
                origin,
                presentationId: "actpause_action",
                decision: "approve",
                outcome: { status: "unknown" },
                settled: false,
              });
              expect(BrowserApprovalResume.followUpKey(uncertain, true)).toBeNull();
              expect(BrowserApprovalResume.followUpKey(uncertain, false)).toContain(":unknown");
              expect(
                BrowserApprovalResume.followUpKey({ ...uncertain, settled: true }, false),
              ).toContain(":settled");
              yield* store.retainDecision(uncertain);
              expect(
                BrowserApprovalResume.instruction(yield* store.decision(origin.actionId)),
              ).toContain("Do not repeat");
              yield* store.pruneOrigins(new Set([origin.actionId]));
              expect(yield* store.origin(origin.actionId)).toEqual(origin);
              yield* store.forget(origin.actionId);
              expect(yield* store.pending()).toEqual([]);
              yield* store.retainOrigin(origin);
              yield* store.retainDecision(uncertain);
              yield* AgentStorageErasure.erase(state.storage);
              expect(yield* store.pending()).toEqual([]);
              expect(
                yield* Effect.promise(() =>
                  state.storage.list({ prefix: "browser-approval-origin:" }),
                ),
              ).toHaveProperty("size", 0);
            }),
          );
        },
      );
    }),
);
