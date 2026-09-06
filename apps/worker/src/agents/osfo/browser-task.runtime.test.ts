/* oxlint-disable effecttsgo/async-function -- Cloudflare callbacks are Promise boundaries. */
/* oxlint-disable vitest/no-standalone-expect, eslint/no-underscore-dangle -- Effect callbacks assert canonical browser outcomes. */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { BrowserOutcome, BrowserRequest } from "@osfo/api/browser-host";

import { ThinkSubmissionId, UserId } from "../../domain";
import { Browser } from "../../services/browser-host";
import type { OsfoAgent } from "./agent";
import { BrowserTask, matchesObservation } from "./browser-task";

it.effect(
  "retains intent and uncertain effects across Sessions, rejects changed evidence, and requires host cleanup before erasure",
  () =>
    Effect.promise(async () => {
      // SAFETY: wrangler.runtime.jsonc binds this namespace directly to OsfoAgent.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The generated production Env omits this test binding.
      const runtimeEnv = env as typeof env & {
        readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
      };
      const stub = runtimeEnv.OSFO_AGENT_TEST.getByName("browser-task-retention");
      await runInDurableObject(stub, async (_agent, state) => {
        await Effect.runPromise(
          Effect.gen(function* () {
            const userId = UserId.make("browser-task-owner");
            const binding: Browser.Binding = {
              ownerUserId: userId,
              hostSessionId: "hosted-fixture",
            };
            const first = {
              userId,
              turnId: ThinkSubmissionId.make("first-session-turn"),
              operationId: "owned-task",
            };
            const requestText = "Open https://portal.example/book. Prefer Tuesday morning.";
            const requests: Array<BrowserRequest> = [];
            let cleanupSucceeded = false;
            let admitted = true;
            let now = 1;
            const options: BrowserTask.Options = {
              storage: state.storage,
              binding: () => binding,
              now: Effect.sync(() => now),
              authorize: () =>
                admitted
                  ? Effect.void
                  : Effect.fail(new Browser.BrowserUnavailable({ message: "revoked" })),
              cleanup: () =>
                cleanupSucceeded
                  ? Effect.void
                  : Effect.fail(new Browser.BrowserUnavailable({ message: "cleanup unconfirmed" })),
              dispatch: (request) =>
                Effect.sync((): BrowserOutcome => {
                  requests.push(request);
                  if (request.command._tag === "Interact" || request.command._tag === "Outcome")
                    return { _tag: "Unknown" };
                  return {
                    _tag: "Observed",
                    observation: {
                      taskId: request.taskId,
                      observationId: request.operationId,
                      observedAt: 1,
                      url: "https://portal.example/book",
                      text: "  1 AXButton Confirm appointment",
                    },
                  };
                }),
            };
            const tasks = BrowserTask.make(options);
            for (const url of [
              "https://other.example/book",
              "http://portal.example/book",
              "https://user:password@portal.example/book",
            ]) {
              expect((yield* tasks.open(first, url, requestText).pipe(Effect.flip))._tag).toBe(
                "BrowserUnavailable",
              );
            }
            expect(requests).toHaveLength(0);
            const opened = yield* tasks.open(first, "https://portal.example/book", requestText);
            expect(opened.requestText).toBe(requestText);
            const approved = {
              taskId: first.operationId,
              observationId: first.operationId,
              expectedUrl: "https://portal.example/book",
              targetDescription: "1 AXButton Confirm appointment",
              interaction: { _tag: "Click", target: "1" } as const,
              consequence: "Confirm the Tuesday morning appointment",
            };
            expect(matchesObservation(opened, approved)).toBe(true);
            expect(
              matchesObservation(opened, { ...approved, expectedUrl: "https://other.example" }),
            ).toBe(false);
            expect(
              matchesObservation(opened, {
                ...approved,
                targetDescription: "1 AXButton Read only",
              }),
            ).toBe(false);
            now = 300_001;
            const expired = yield* tasks.read(first.operationId, userId);
            expect(expired.observation).toBeNull();
            expect(matchesObservation(expired, approved)).toBe(false);
            expect(
              (yield* tasks
                .run({ ...first, operationId: "expired-effect" }, first.operationId, {
                  _tag: "Interact",
                  observationId: first.operationId,
                  interaction: approved.interaction,
                })
                .pipe(Effect.flip))._tag,
            ).toBe("BrowserUnavailable");
            now = 1;
            const uncertain = yield* tasks.run(
              { ...first, operationId: "approved-effect" },
              first.operationId,
              {
                _tag: "Interact",
                observationId: first.operationId,
                interaction: approved.interaction,
              },
            );
            expect(uncertain.uncertainOperationId).toBe("approved-effect");
            const resumed = BrowserTask.make(options);
            const next = {
              ...first,
              turnId: ThinkSubmissionId.make("second-session-turn"),
              operationId: "fresh-observation",
            };
            const listed = yield* resumed.list(next);
            expect(listed[0]?.requestText).toBe(requestText);
            yield* resumed.run(next, first.operationId, { _tag: "Observe" });
            const retry = yield* resumed
              .run({ ...next, operationId: "retry-effect" }, first.operationId, {
                _tag: "Interact",
                observationId: next.operationId,
                interaction: approved.interaction,
              })
              .pipe(Effect.flip);
            expect(retry._tag).toBe("BrowserUnavailable");
            expect(requests.filter((request) => request.command._tag === "Interact")).toHaveLength(
              1,
            );
            const other = yield* resumed
              .read(first.operationId, UserId.make("other-owner"))
              .pipe(Effect.flip);
            expect(other._tag).toBe("BrowserUnavailable");
            admitted = false;
            expect(
              (yield* resumed.run(next, first.operationId, { _tag: "Observe" }).pipe(Effect.flip))
                ._tag,
            ).toBe("BrowserUnavailable");
            expect((yield* resumed.quiesce(userId).pipe(Effect.flip))._tag).toBe(
              "BrowserUnavailable",
            );
            expect(
              yield* Effect.promise(() => state.storage.get(`browser-task:${first.operationId}`)),
            ).toBeDefined();
            cleanupSucceeded = true;
            yield* resumed.quiesce(userId);
            expect(
              yield* Effect.promise(() => state.storage.get(`browser-task:${first.operationId}`)),
            ).toBeUndefined();
            const unbound = BrowserTask.make({ ...options, binding: () => null });
            yield* unbound.quiesce(userId);
            cleanupSucceeded = false;
            expect((yield* unbound.quiesce(userId).pipe(Effect.flip))._tag).toBe(
              "BrowserUnavailable",
            );
          }),
        );
      });
    }),
);
