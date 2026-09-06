/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect-owned native Durable Object callback. */
/* oxlint-disable effecttsgo/async-function -- The installed native fiber API and Durable Object test callback are Promise boundaries. */
import { expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Deferred, Effect } from "effect";
import { vi } from "vitest";

it.effect("resumes only one exact interrupted native fiber without replacing its checkpoint", () =>
  Effect.promise(async () => {
    const stub = env.OSFO_DIRECTORY.getByName("whatsapp-native-fiber-resume");
    await runInDurableObject(stub, async (host, state) => {
      const snapshot = {
        type: "think:messenger-reply",
        stage: "accepted",
        acceptance: { submissionId: "existing-submission" },
      };
      state.storage.sql.exec(
        "INSERT INTO cf_agents_fibers (fiber_id, idempotency_key, name, status, snapshot, metadata_json, error_message, created_at, started_at, completed_at) VALUES (?, ?, ?, 'interrupted', ?, ?, NULL, 1, 1, 2)",
        "interrupted-reply",
        "exact-provider-message",
        "think:messenger-reply",
        JSON.stringify(snapshot),
        JSON.stringify({ submissionId: "existing-submission" }),
      );
      const started = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      let executions = 0;
      const execute = async () => {
        executions += 1;
        await Effect.runPromise(Deferred.succeed(started, undefined));
        await Effect.runPromise(Deferred.await(release));
      };
      const options = { fiberId: "interrupted-reply", resumeInterrupted: true };
      const [first, duplicate] = await Promise.all([
        host.startFiber("think:messenger-reply", execute, options),
        host.startFiber("think:messenger-reply", execute, options),
      ]);
      expect([first.accepted, duplicate.accepted]).toEqual([true, false]);
      await Effect.runPromise(Deferred.await(started));
      const running = await host.inspectFiber("interrupted-reply");
      expect(running).toMatchObject({
        status: "running",
        snapshot,
        metadata: { submissionId: "existing-submission" },
      });
      expect(executions).toBe(1);
      await Effect.runPromise(Deferred.succeed(release, undefined));
      const completed = await host.startFiber("think:messenger-reply", execute, {
        ...options,
        waitForCompletion: true,
      });
      expect(completed.status).toBe("completed");
      expect((await host.startFiber("think:messenger-reply", execute, options)).accepted).toBe(
        false,
      );
      expect(executions).toBe(1);
    });
  }),
);

it.effect("persists the first native checkpoint before keepAlive permits execution", () =>
  Effect.promise(async () => {
    const stub = env.OSFO_DIRECTORY.getByName("whatsapp-native-initial-checkpoint");
    await runInDurableObject(stub, async (host) => {
      const entered = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const snapshot = { type: "accepted-input", submissionId: "original-submission" };
      const held = vi.spyOn(host, "keepAlive").mockImplementation(async () => {
        await Effect.runPromise(Deferred.succeed(entered, undefined));
        await Effect.runPromise(Deferred.await(release));
        return () => {};
      });
      try {
        const accepted = await host.startFiber(
          "initial-checkpoint-proof",
          async (context) => {
            expect(context.snapshot).toEqual(snapshot);
          },
          { fiberId: "before-first-callback", initialSnapshot: snapshot },
        );
        await Effect.runPromise(Deferred.await(entered));
        expect(accepted).toMatchObject({ accepted: true, snapshot });
        expect(await host.inspectFiber("before-first-callback")).toMatchObject({
          status: "running",
          snapshot,
        });
        const duplicate = await host.startFiber("initial-checkpoint-proof", async () => {}, {
          fiberId: "before-first-callback",
        });
        expect(duplicate).toMatchObject({ accepted: false, snapshot });
      } finally {
        await Effect.runPromise(Deferred.succeed(release, undefined));
        await host.startFiber("initial-checkpoint-proof", async () => {}, {
          fiberId: "before-first-callback",
          waitForCompletion: true,
        });
        held.mockRestore();
      }
    });
  }),
);

it.effect("retries a failed native execution through its retained ledger and alarm", () =>
  Effect.promise(async () => {
    const stub = env.OSFO_DIRECTORY.getByName("whatsapp-native-transient-recovery");
    await runInDurableObject(stub, async (host, state) => {
      let attempts = 0;
      const snapshot = { submissionId: "same-submission" };
      const execute = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Transient retained result lookup failure");
      };
      const recovered = vi.spyOn(host, "onFiberRecovered").mockImplementation(async (context) => {
        await host.startFiber(context.name, execute, {
          fiberId: context.id,
          resumeInterrupted: true,
          retryOnError: true,
        });
      });
      try {
        await host.startFiber("transient-recovery-proof", execute, {
          fiberId: "retained-transient-reply",
          initialSnapshot: snapshot,
          retryOnError: true,
        });
        await vi.waitFor(async () => {
          expect(await host.inspectFiber("retained-transient-reply")).toMatchObject({
            status: "pending",
            snapshot,
          });
        });
        expect(await state.storage.getAlarm()).not.toBeNull();
        await host.alarm();
        const completed = await host.startFiber("transient-recovery-proof", execute, {
          fiberId: "retained-transient-reply",
          waitForCompletion: true,
        });
        expect(completed).toMatchObject({ status: "completed", snapshot });
        expect(attempts).toBe(2);
      } finally {
        recovered.mockRestore();
      }
    });
  }),
);
