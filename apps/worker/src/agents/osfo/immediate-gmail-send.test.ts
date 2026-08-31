/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date-in-effect, eslint/no-underscore-dangle, osfo/no-chained-type-assertions, osfo/no-runtime-typeof, osfo/no-unknown-parameters, typescript/no-unsafe-type-assertion, unicorn/no-array-sort, vitest/no-standalone-expect -- Tests use fixed Date fixtures, narrow async host fakes, sort fresh arrays, and inspect tagged Effect outcomes. */
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { AllowancePeriodId, ManifestVersion, UserId } from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { AuthSessionId } from "../../domain/auth-session";
import { GmailMessageInput } from "../../domain/integration-manifest";
import { Integrations } from "../../services/integrations";
import { ActionPresentationId } from "./think-action-approvals";
import { ImmediateGmailSend } from "./immediate-gmail-send";

const connectionBinding = Integrations.IntegrationConnectionBinding.make("a".repeat(64));

it.effect("retains immutable Gmail facts and hides them from another User", () =>
  Effect.gen(function* () {
    const { contexts, store } = memoryStore();
    const candidate = {
      actionId: ActionId.make("gmail-action-1"),
      allowancePeriodId: AllowancePeriodId.make("period-1"),
      connectionBinding,
      authorityIdentity: {
        _tag: "AuthSession",
        authSessionId: AuthSessionId.make("auth-session-1"),
        userId: UserId.make("user-1"),
      },
      input: {
        body: "Exact body",
        gmailResource: "primary",
        recipients: ["person@example.test"],
        subject: "Exact subject",
      },
      presentationId: ActionPresentationId.make("presentation-1"),
    } as const;

    expect(yield* store.retain(candidate)).toMatchObject(candidate);
    expect(yield* store.retain(candidate)).toMatchObject(candidate);
    expect((yield* store.listForUser(candidate.authorityIdentity.userId)).open).toHaveLength(1);
    expect(
      yield* store.readForUser(candidate.actionId, UserId.make("user-2")).pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: "ImmediateGmailSendNotFound" } });
    expect(yield* store.listForUser(UserId.make("user-2"))).toEqual({ open: [], terminal: [] });

    expect(
      yield* store
        .retain({ ...candidate, input: { ...candidate.input, body: "Changed body" } })
        .pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: "ImmediateGmailSendConflict" } });

    yield* store.deleteUser(candidate.authorityIdentity.userId);
    expect(contexts.size).toBe(0);
  }),
);

it.effect("projects only the newest fifty Gmail Actions", () =>
  Effect.gen(function* () {
    const { store, terminal } = memoryStore();
    const userId = UserId.make("user-1");

    yield* Effect.forEach(
      Array.from({ length: 52 }, (_, index) => index),
      (index) =>
        store
          .retain({
            actionId: ActionId.make(`gmail-action-${index}`),
            allowancePeriodId: AllowancePeriodId.make("period-1"),
            connectionBinding,
            authorityIdentity: {
              _tag: "AuthSession",
              authSessionId: AuthSessionId.make("auth-session-1"),
              userId,
            },
            input: {
              body: `Body ${index}`,
              gmailResource: "primary",
              recipients: ["person@example.test"],
              subject: `Subject ${index}`,
            },
            presentationId: ActionPresentationId.make(`presentation-${index}`),
          })
          .pipe(Effect.flatMap((context) => store.settle(context, "applied"))),
    );

    const visible = (yield* store.listForUser(userId)).terminal;
    expect(visible).toHaveLength(ImmediateGmailSend.maximumVisibleActions);
    expect(visible.at(0)?.actionId).toBe("gmail-action-51");
    expect(visible.at(-1)?.actionId).toBe("gmail-action-2");
    expect(terminal.size).toBe(ImmediateGmailSend.maximumVisibleActions);
    expect(yield* store.listAllForUser(userId)).toHaveLength(0);
  }),
);

it.effect("compacts durable terminal visibility and bulk-deletes bounded User state", () =>
  Effect.gen(function* () {
    const { batches, records, storage } = durableStorageFake();
    const persistence = ImmediateGmailSend.makeDurableObjectPersistence(storage);
    const userId = candidate.authorityIdentity.userId;

    yield* Effect.forEach(
      Array.from({ length: 52 }, (_, index) => index),
      (index) => {
        const next = {
          ...candidate,
          actionId: ActionId.make(`terminal-action-${String(index).padStart(3, "0")}`),
          presentationId: ActionPresentationId.make(`terminal-presentation-${index}`),
        };
        return persistence.retain(next).pipe(
          Effect.flatMap((retained) =>
            Schema.decodeUnknownEffect(ImmediateGmailSend.Context)(retained),
          ),
          Effect.flatMap((context) => persistence.settle(context, "applied")),
        );
      },
    );
    expect(yield* persistence.listTerminal(100)).toHaveLength(50);
    expect(yield* persistence.listOpen()).toHaveLength(0);

    yield* Effect.forEach(
      Array.from({ length: ImmediateGmailSend.maximumOpenActions }, (_, index) => index),
      (index) =>
        persistence.retain({
          ...candidate,
          actionId: ActionId.make(`open-action-${index}`),
          presentationId: ActionPresentationId.make(`open-presentation-${index}`),
        }),
    );
    batches.length = 0;
    yield* persistence.deleteUser(userId);
    expect(batches.map((batch) => batch.length)).toEqual([101]);
    expect(records.size).toBe(0);
  }),
);

it.effect("orders and prunes terminal visibility by settlement rather than retention", () =>
  Effect.gen(function* () {
    const { store } = memoryStore();
    const old = yield* store.retain({
      ...candidate,
      actionId: ActionId.make("old-action"),
      presentationId: ActionPresentationId.make("old-presentation"),
    });
    yield* Effect.forEach(
      Array.from({ length: ImmediateGmailSend.maximumVisibleActions }, (_, index) => index),
      (index) =>
        store
          .retain({
            ...candidate,
            actionId: ActionId.make(`newer-action-${index}`),
            presentationId: ActionPresentationId.make(`newer-presentation-${index}`),
          })
          .pipe(Effect.flatMap((context) => store.settle(context, "applied"))),
    );
    yield* store.settle(old, "applied");

    const visible = (yield* store.listForUser(candidate.authorityIdentity.userId)).terminal;
    expect(visible).toHaveLength(ImmediateGmailSend.maximumVisibleActions);
    expect(visible[0]?.actionId).toBe(old.actionId);
    expect(visible.some((status) => status.actionId === "newer-action-0")).toBe(false);
  }),
);

it.effect("rejects the fifty-first open Action before any provider effect", () =>
  Effect.gen(function* () {
    const { storage } = durableStorageFake();
    const store = ImmediateGmailSend.make(ImmediateGmailSend.makeDurableObjectPersistence(storage));
    yield* Effect.forEach(
      Array.from({ length: ImmediateGmailSend.maximumOpenActions }, (_, index) => index),
      (index) =>
        store.retain({
          ...candidate,
          actionId: ActionId.make(`bounded-open-${index}`),
          presentationId: ActionPresentationId.make(`bounded-presentation-${index}`),
        }),
    );
    let providerEffects = 0;
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: noAccounting,
      integrations: {
        execute: () =>
          Effect.sync(() => {
            providerEffects += 1;
            return appliedResult;
          }),
        inspectAction: () => Effect.succeed({ _tag: "NotStarted" }),
        readActionStatus: () => Effect.succeed({ _tag: "NotStarted" }),
      },
      scheduler: schedulerRecording([]),
      store,
    });
    const overflow = {
      ...candidate,
      actionId: ActionId.make("bounded-open-overflow"),
      presentationId: ActionPresentationId.make("bounded-presentation-overflow"),
    };

    expect(
      yield* coordinator
        .execute(overflow, Effect.succeed(candidate.allowancePeriodId), Effect.void)
        .pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: "ImmediateGmailSendConflict" } });
    expect(providerEffects).toBe(0);
  }),
);

it.effect("recovers a retained Action on activation after scheduler retries exhaust", () =>
  Effect.gen(function* () {
    const { store } = memoryStore();
    yield* store.retain(candidate);
    let schedulerAvailable = false;
    let scheduleAttempts = 0;
    const recovered: Array<ScheduledInspection> = [];
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: noAccounting,
      integrations: {
        execute: () => Effect.succeed(appliedResult),
        inspectAction: () => Effect.succeed({ _tag: "Pending" }),
        readActionStatus: () => Effect.succeed({ _tag: "Pending" }),
      },
      scheduler: {
        schedule: (_actionId, _userId, delayMilliseconds, idempotent) =>
          Effect.suspend(() => {
            scheduleAttempts += 1;
            return schedulerAvailable
              ? Effect.sync(() => recovered.push({ delayMilliseconds, idempotent }))
              : Effect.fail(
                  new ImmediateGmailSend.Unavailable({
                    cause: "scheduler unavailable",
                    message: "scheduler unavailable",
                    operation: "test.schedule",
                  }),
                );
          }),
      },
      store,
    });

    yield* Effect.forEach(
      Array.from({ length: 10 }, () => undefined),
      () =>
        coordinator
          .reconcile(candidate.actionId, candidate.authorityIdentity.userId)
          .pipe(Effect.result),
      { discard: true },
    );
    schedulerAvailable = true;
    yield* coordinator.recoverOnActivation();

    expect(scheduleAttempts).toBe(11);
    expect(recovered).toEqual([
      {
        delayMilliseconds: Integrations.initialActionReconciliationDelayMilliseconds,
        idempotent: true,
      },
    ]);
  }),
);

it("binds an Approval to the unchanged private Connection identity", () => {
  const connectedA = {
    _tag: "IntegrationConnectionConnected" as const,
    connectionBinding,
    toolkit: "gmail",
    userId: candidate.authorityIdentity.userId,
  };
  const connectedB = {
    ...connectedA,
    connectionBinding: Integrations.IntegrationConnectionBinding.make("b".repeat(64)),
  };

  expect(ImmediateGmailSend.hasCurrentConnectionBinding(connectedA, connectionBinding)).toBe(true);
  expect(ImmediateGmailSend.hasCurrentConnectionBinding(connectedB, connectionBinding)).toBe(false);
});

it.effect("retains before execution and schedules one initial ambiguous inspection", () =>
  Effect.gen(function* () {
    const { contexts, store } = memoryStore();
    const scheduled: Array<ScheduledInspection> = [];
    let executions = 0;
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: noAccounting,
      integrations: {
        readActionStatus: () => Effect.succeed({ _tag: "NotStarted" }),
        execute: (input) =>
          Effect.gen(function* () {
            executions += 1;
            expect(contexts.has(candidate.actionId)).toBe(true);
            yield* input.authorize;
            return yield* new Integrations.IntegrationActionAmbiguous({
              actionId: candidate.actionId,
              message: "provider outcome unknown",
            });
          }),
        inspectAction: () => Effect.succeed({ _tag: "NotStarted" }),
      },
      scheduler: schedulerRecording(scheduled),
      store,
    });

    expect(
      yield* coordinator
        .execute(candidate, Effect.succeed(candidate.allowancePeriodId), Effect.void)
        .pipe(Effect.result),
    ).toMatchObject({
      failure: { _tag: "IntegrationActionAmbiguous" },
    });
    expect(executions).toBe(1);
    expect(scheduled).toEqual([
      {
        delayMilliseconds: Integrations.initialActionReconciliationDelayMilliseconds,
        idempotent: true,
      },
    ]);
  }),
);

it.effect("does not start the provider effect until the durable recovery handoff commits", () =>
  Effect.gen(function* () {
    const { contexts, store } = memoryStore();
    let executions = 0;
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: noAccounting,
      integrations: {
        readActionStatus: () => Effect.succeed({ _tag: "NotStarted" }),
        execute: () => {
          executions += 1;
          return Effect.succeed(appliedResult);
        },
        inspectAction: () => Effect.succeed({ _tag: "NotStarted" }),
      },
      scheduler: {
        schedule: () =>
          Effect.fail(
            new ImmediateGmailSend.Unavailable({
              cause: "scheduler unavailable",
              message: "Gmail Action reconciliation could not be scheduled",
              operation: "schedule",
            }),
          ),
      },
      store,
    });

    expect(
      yield* coordinator
        .execute(candidate, Effect.succeed(candidate.allowancePeriodId), Effect.void)
        .pipe(Effect.result),
    ).toMatchObject({
      failure: { _tag: "ImmediateGmailSendUnavailable" },
    });
    expect(contexts.has(candidate.actionId)).toBe(true);
    expect(executions).toBe(0);
  }),
);

it.effect("projects retained status without provider inspection or accounting", () =>
  Effect.gen(function* () {
    const { store } = memoryStore();
    yield* store.retain(candidate);
    let inspections = 0;
    let accounting = 0;
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: {
        record: () =>
          Effect.sync(() => {
            accounting += 1;
          }),
      },
      integrations: {
        execute: () => Effect.succeed(appliedResult),
        inspectAction: () => {
          inspections += 1;
          return Effect.succeed({ _tag: "Applied", result: appliedResult });
        },
        readActionStatus: () => Effect.succeed({ _tag: "Applied", result: appliedResult }),
      },
      scheduler: schedulerRecording([]),
      store,
    });

    expect(yield* coordinator.inspectForUser(candidate.authorityIdentity.userId)).toEqual({
      items: [
        {
          actionId: candidate.actionId,
          presentationId: candidate.presentationId,
          status: "applied",
        },
      ],
    });
    expect(inspections).toBe(0);
    expect(accounting).toBe(0);
  }),
);

it.effect("reschedules only open reconciliation states and never resends", () =>
  Effect.gen(function* () {
    const { store } = memoryStore();
    yield* store.retain(candidate);
    const scheduled: Array<ScheduledInspection> = [];
    const inspections: Array<Integrations.IntegrationActionInspection> = [
      { _tag: "Pending" },
      { _tag: "Ambiguous", retryAfterMilliseconds: 17_000 },
      { _tag: "Applied", result: appliedResult },
      { _tag: "NotApplied", providerLogId: null },
      { _tag: "TerminalAmbiguous" },
    ];
    let executions = 0;
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: noAccounting,
      integrations: {
        readActionStatus: () => Effect.succeed({ _tag: "NotStarted" }),
        execute: () => {
          executions += 1;
          return Effect.succeed(appliedResult);
        },
        inspectAction: () => Effect.succeed(requiredInspection(inspections)),
      },
      scheduler: schedulerRecording(scheduled),
      store,
    });

    yield* Effect.forEach(
      inspections.map((_, index) => index),
      () => coordinator.reconcile(candidate.actionId, candidate.authorityIdentity.userId),
    );
    expect(scheduled).toEqual([
      {
        delayMilliseconds: Integrations.initialActionReconciliationDelayMilliseconds,
        idempotent: false,
      },
      { delayMilliseconds: 17_000, idempotent: false },
    ]);
    expect(executions).toBe(0);
  }),
);

it.effect("schedules recovery when Applied accounting fails after provider settlement", () =>
  Effect.gen(function* () {
    const { store } = memoryStore();
    const scheduled: Array<ScheduledInspection> = [];
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: {
        record: () =>
          Effect.fail(
            new Integrations.IntegrationEffectFinalizationUnavailable({
              cause: "database unavailable after Applied settlement",
              message: "Gmail Action accounting is unavailable",
              operation: "accounting.gmailSend",
            }),
          ),
      },
      integrations: {
        readActionStatus: () => Effect.succeed({ _tag: "NotStarted" }),
        execute: (input) =>
          (input.finalizeEffect?.({ _tag: "Applied", result: appliedResult }) ?? Effect.void).pipe(
            Effect.as(appliedResult),
          ),
        inspectAction: () => Effect.succeed({ _tag: "Applied", result: appliedResult }),
      },
      scheduler: schedulerRecording(scheduled),
      store,
    });

    expect(
      yield* coordinator
        .execute(candidate, Effect.succeed(candidate.allowancePeriodId), Effect.void)
        .pipe(Effect.result),
    ).toMatchObject({
      failure: { _tag: "IntegrationEffectFinalizationUnavailable" },
    });
    expect(scheduled).toEqual([
      {
        delayMilliseconds: Integrations.initialActionReconciliationDelayMilliseconds,
        idempotent: true,
      },
    ]);
  }),
);

it.effect("blocks deletion while reconciliation is open and removes context after settlement", () =>
  Effect.gen(function* () {
    const { contexts, store } = memoryStore();
    yield* store.retain(candidate);
    const scheduled: Array<ScheduledInspection> = [];
    const inspections: Array<Integrations.IntegrationActionInspection> = [
      { _tag: "Pending" },
      { _tag: "Applied", result: appliedResult },
    ];
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: noAccounting,
      integrations: {
        readActionStatus: () => Effect.succeed({ _tag: "NotStarted" }),
        execute: () => Effect.succeed(appliedResult),
        inspectAction: () => Effect.succeed(requiredInspection(inspections)),
      },
      scheduler: schedulerRecording(scheduled),
      store,
    });

    expect(
      yield* coordinator.quiesceUser(candidate.authorityIdentity.userId).pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: "ImmediateGmailSendUnavailable" } });
    expect(contexts.size).toBe(1);
    yield* coordinator.quiesceUser(candidate.authorityIdentity.userId);
    expect(contexts.size).toBe(0);
    yield* coordinator.deleteUser(candidate.authorityIdentity.userId);
    expect(contexts.size).toBe(0);
    expect(scheduled).toEqual([
      {
        delayMilliseconds: Integrations.initialActionReconciliationDelayMilliseconds,
        idempotent: true,
      },
    ]);
  }),
);

it.effect("blocks deletion for an unresolved Action older than the visible fifty", () =>
  Effect.gen(function* () {
    const { store } = memoryStore();
    yield* Effect.forEach(
      Array.from({ length: 51 }, (_, index) => index),
      (index) =>
        store.retain({
          ...candidate,
          actionId: ActionId.make(`quiesce-action-${index}`),
          presentationId: ActionPresentationId.make(`quiesce-presentation-${index}`),
        }),
    );
    const scheduled: Array<ScheduledInspection> = [];
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: noAccounting,
      integrations: {
        readActionStatus: () => Effect.succeed({ _tag: "NotStarted" }),
        execute: () => Effect.succeed(appliedResult),
        inspectAction: ({ actionId }) =>
          Effect.succeed(
            actionId === "quiesce-action-0"
              ? ({ _tag: "Pending" } as const)
              : ({ _tag: "Applied", result: appliedResult } as const),
          ),
      },
      scheduler: schedulerRecording(scheduled),
      store,
    });

    expect(
      yield* coordinator.quiesceUser(candidate.authorityIdentity.userId).pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: "ImmediateGmailSendUnavailable" } });
    expect(scheduled).toContainEqual({
      delayMilliseconds: Integrations.initialActionReconciliationDelayMilliseconds,
      idempotent: true,
    });
  }),
);

it.effect("compacts a settled accounting identity so later wakes are no-ops", () =>
  Effect.gen(function* () {
    const { store } = memoryStore();
    yield* store.retain(candidate);
    const recorded = new Set<string>();
    let finalizerCalls = 0;
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: {
        record: (context, basis) =>
          Effect.sync(() => {
            recorded.add(`${context.actionId}:${basis}`);
          }),
      },
      integrations: {
        readActionStatus: () => Effect.succeed({ _tag: "NotStarted" }),
        execute: () => Effect.succeed(appliedResult),
        inspectAction: (input) =>
          Effect.gen(function* () {
            finalizerCalls += 1;
            yield* (
              input.finalizeEffect?.({ _tag: "Applied", result: appliedResult }) ?? Effect.void
            );
            return { _tag: "Applied" as const, result: appliedResult };
          }),
      },
      scheduler: schedulerRecording([]),
      store,
    });

    yield* coordinator.reconcile(candidate.actionId, candidate.authorityIdentity.userId);
    yield* coordinator.reconcile(candidate.actionId, candidate.authorityIdentity.userId);
    expect(finalizerCalls).toBe(1);
    expect(recorded).toEqual(new Set([`${candidate.actionId}:observed`]));
  }),
);

it.effect("accepts the pre-scheduled wake after an immediate Applied settlement", () =>
  Effect.gen(function* () {
    const { contexts, store, terminal } = memoryStore();
    const scheduled: Array<ScheduledInspection> = [];
    let providerInspections = 0;
    let accounting = 0;
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: {
        record: () =>
          Effect.sync(() => {
            accounting += 1;
          }),
      },
      integrations: {
        readActionStatus: () => Effect.succeed({ _tag: "NotStarted" }),
        execute: () => Effect.succeed(appliedResult),
        inspectAction: () => {
          providerInspections += 1;
          return Effect.succeed({ _tag: "Applied", result: appliedResult });
        },
      },
      scheduler: schedulerRecording(scheduled),
      store,
    });

    yield* coordinator.execute(candidate, Effect.succeed(candidate.allowancePeriodId), Effect.void);
    expect(contexts.size).toBe(0);
    expect(terminal.get(candidate.actionId)?.status).toBe("applied");
    yield* coordinator.reconcile(candidate.actionId, candidate.authorityIdentity.userId);
    expect(providerInspections).toBe(0);
    expect(accounting).toBe(0);
  }),
);

it.effect("replays a settled Action without re-admission or accounting in a renewed period", () =>
  Effect.gen(function* () {
    const { store } = memoryStore();
    const approvedPeriod = AllowancePeriodId.make("period-at-approval");
    const renewedPeriod = AllowancePeriodId.make("period-after-renewal");
    const recorded: Array<AllowancePeriodId> = [];
    let admissions = 0;
    let rechecks = 0;
    let applied = false;
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: {
        record: (context) =>
          Effect.sync(() => {
            recorded.push(context.allowancePeriodId);
          }),
      },
      integrations: {
        readActionStatus: () =>
          Effect.succeed(
            applied
              ? { _tag: "Applied" as const, result: appliedResult }
              : { _tag: "NotStarted" as const },
          ),
        execute: (input) => {
          if (applied) {
            expect(input.finalizeEffect).toBeUndefined();
            return Effect.succeed(appliedResult);
          }
          return input.authorize.pipe(
            Effect.andThen(
              input.finalizeEffect?.({ _tag: "Applied", result: appliedResult }) ?? Effect.void,
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                applied = true;
              }),
            ),
            Effect.as(appliedResult),
          );
        },
        inspectAction: () => Effect.die(new Error("a compact terminal Action is not reinspected")),
      },
      scheduler: schedulerRecording([]),
      store,
    });

    yield* coordinator.execute(
      candidate,
      Effect.sync(() => {
        admissions += 1;
        return approvedPeriod;
      }),
      Effect.sync(() => {
        rechecks += 1;
      }),
    );
    yield* coordinator.execute(
      candidate,
      Effect.sync(() => {
        admissions += 1;
        return renewedPeriod;
      }),
      Effect.sync(() => {
        rechecks += 1;
      }),
    );
    expect(admissions).toBe(1);
    expect(rechecks).toBe(1);
    expect(recorded).toEqual([approvedPeriod]);
  }),
);

it.effect("validates terminal replay input and Approval identity without re-admission", () =>
  Effect.gen(function* () {
    const { store } = memoryStore();
    const context = yield* store.retain(candidate);
    yield* store.settle(context, "applied");
    let admissions = 0;
    let executions = 0;
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: noAccounting,
      integrations: {
        readActionStatus: (input) =>
          Schema.is(GmailMessageInput)(input.input) && input.input.body === candidate.input.body
            ? Effect.succeed({ _tag: "Applied", result: appliedResult })
            : Effect.fail(
                new Integrations.IntegrationActionConflict({
                  actionId: input.actionId,
                  message: "changed terminal input",
                }),
              ),
        execute: () => {
          executions += 1;
          return Effect.succeed(appliedResult);
        },
        inspectAction: () => Effect.die(new Error("terminal replay is not inspected")),
      },
      scheduler: schedulerRecording([]),
      store,
    });
    const admit = Effect.sync(() => {
      admissions += 1;
      return AllowancePeriodId.make("renewed-period");
    });

    expect(
      yield* coordinator
        .execute(
          { ...candidate, input: { ...candidate.input, body: "Changed terminal body" } },
          admit,
          Effect.void,
        )
        .pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: "IntegrationActionConflict" } });
    expect(
      yield* coordinator
        .execute(
          {
            ...candidate,
            presentationId: ActionPresentationId.make("different-presentation"),
          },
          admit,
          Effect.void,
        )
        .pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: "ImmediateGmailSendConflict" } });
    expect(admissions).toBe(0);
    expect(executions).toBe(0);
  }),
);

it.effect("replays terminal NotApplied and Ambiguous outcomes without new accounting", () =>
  Effect.forEach(["notApplied", "ambiguous"] as const, (status) =>
    Effect.gen(function* () {
      const { store } = memoryStore();
      const context = yield* store.retain(candidate);
      yield* store.settle(context, status);
      let admissions = 0;
      let rechecks = 0;
      let accounting = 0;
      const coordinator = ImmediateGmailSend.makeCoordinator({
        accounting: {
          record: () =>
            Effect.sync(() => {
              accounting += 1;
            }),
        },
        integrations: {
          readActionStatus: () =>
            Effect.succeed(
              status === "notApplied"
                ? { _tag: "NotApplied" as const, providerLogId: null }
                : { _tag: "TerminalAmbiguous" as const },
            ),
          execute: () =>
            status === "notApplied"
              ? Effect.fail(
                  new Integrations.IntegrationActionNotApplied({
                    actionId: candidate.actionId,
                    message: "finally not applied",
                    providerLogId: null,
                  }),
                )
              : Effect.fail(
                  new Integrations.IntegrationActionAmbiguous({
                    actionId: candidate.actionId,
                    message: "terminal provider ambiguity",
                  }),
                ),
          inspectAction: () => Effect.die(new Error("terminal replay is not inspected")),
        },
        scheduler: schedulerRecording([]),
        store,
      });

      expect(
        yield* coordinator
          .execute(
            candidate,
            Effect.sync(() => {
              admissions += 1;
              return AllowancePeriodId.make("renewed-period");
            }),
            Effect.sync(() => {
              rechecks += 1;
            }),
          )
          .pipe(Effect.result),
      ).toMatchObject({
        failure: {
          _tag:
            status === "notApplied" ? "IntegrationActionNotApplied" : "IntegrationActionAmbiguous",
        },
      });
      expect({ accounting, admissions, rechecks }).toEqual({
        accounting: 0,
        admissions: 0,
        rechecks: 0,
      });
    }),
  ),
);

it.effect("replays a provider terminal Action after its bounded UI status is pruned", () =>
  Effect.gen(function* () {
    const { store } = memoryStore();
    const original = yield* store.retain(candidate);
    yield* store.settle(original, "applied");
    yield* Effect.forEach(
      Array.from({ length: ImmediateGmailSend.maximumVisibleActions }, (_, index) => index),
      (index) => {
        const next = {
          ...candidate,
          actionId: ActionId.make(`later-terminal-${index}`),
          presentationId: ActionPresentationId.make(`later-presentation-${index}`),
        };
        return store
          .retain(next)
          .pipe(Effect.flatMap((context) => store.settle(context, "applied")));
      },
    );
    expect(
      yield* store
        .readTerminalForUser(candidate.actionId, candidate.authorityIdentity.userId)
        .pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: "ImmediateGmailSendNotFound" } });
    let admissions = 0;
    let rechecks = 0;
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: noAccounting,
      integrations: {
        readActionStatus: () => Effect.succeed({ _tag: "Applied", result: appliedResult }),
        execute: (input) => {
          expect(input.finalizeEffect).toBeUndefined();
          return Effect.succeed(appliedResult);
        },
        inspectAction: () => Effect.die(new Error("pruned terminal replay is not inspected")),
      },
      scheduler: schedulerRecording([]),
      store,
    });

    expect(
      yield* coordinator.execute(
        candidate,
        Effect.sync(() => {
          admissions += 1;
          return AllowancePeriodId.make("renewed-period");
        }),
        Effect.sync(() => {
          rechecks += 1;
        }),
      ),
    ).toEqual(appliedResult);
    expect({ admissions, rechecks }).toEqual({ admissions: 0, rechecks: 0 });
  }),
);

it.effect("fails connection preflight before retaining or scheduling an Action", () =>
  Effect.gen(function* () {
    const { contexts, store } = memoryStore();
    const scheduled: Array<ScheduledInspection> = [];
    let executions = 0;
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: noAccounting,
      integrations: {
        readActionStatus: () => Effect.succeed({ _tag: "NotStarted" }),
        execute: () => {
          executions += 1;
          return Effect.succeed(appliedResult);
        },
        inspectAction: () => Effect.succeed({ _tag: "NotStarted" }),
      },
      scheduler: schedulerRecording(scheduled),
      store,
    });

    expect(
      yield* coordinator
        .execute(
          candidate,
          Effect.fail(
            new ImmediateGmailSend.Unavailable({
              cause: "missing Gmail connection",
              message: "The current Gmail connection is unavailable",
              operation: "admit",
            }),
          ),
          Effect.void,
        )
        .pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: "ImmediateGmailSendUnavailable" } });
    expect(contexts.size).toBe(0);
    expect(scheduled).toEqual([]);
    expect(executions).toBe(0);
  }),
);

it.effect("rejects a changed-input replay without re-running admission", () =>
  Effect.gen(function* () {
    const { store } = memoryStore();
    yield* store.retain(candidate);
    let admissions = 0;
    let executions = 0;
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: noAccounting,
      integrations: {
        readActionStatus: () => Effect.succeed({ _tag: "NotStarted" }),
        execute: () => {
          executions += 1;
          return Effect.succeed(appliedResult);
        },
        inspectAction: () => Effect.succeed({ _tag: "NotStarted" }),
      },
      scheduler: schedulerRecording([]),
      store,
    });

    expect(
      yield* coordinator
        .execute(
          { ...candidate, input: { ...candidate.input, body: "Changed replay body" } },
          Effect.sync(() => {
            admissions += 1;
            return AllowancePeriodId.make("period-after-renewal");
          }),
          Effect.void,
        )
        .pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: "ImmediateGmailSendConflict" } });
    expect(admissions).toBe(0);
    expect(executions).toBe(0);
  }),
);

it.effect("durably reschedules repeated accounting failures until once-only settlement", () =>
  Effect.gen(function* () {
    const { store } = memoryStore();
    yield* store.retain(candidate);
    const scheduled: Array<ScheduledInspection> = [];
    const recorded = new Set<string>();
    let failuresRemaining = 2;
    const coordinator = ImmediateGmailSend.makeCoordinator({
      accounting: {
        record: (context, basis) =>
          Effect.suspend(() => {
            if (failuresRemaining > 0) {
              failuresRemaining -= 1;
              return Effect.fail(
                new Integrations.IntegrationEffectFinalizationUnavailable({
                  cause: "temporary database outage",
                  message: "Gmail Action accounting is unavailable",
                  operation: "accounting.gmailSend",
                }),
              );
            }
            return Effect.sync(() => {
              recorded.add(`${context.actionId}:${basis}`);
            });
          }),
      },
      integrations: {
        readActionStatus: () => Effect.succeed({ _tag: "NotStarted" }),
        execute: () => Effect.succeed(appliedResult),
        inspectAction: (input) =>
          Effect.gen(function* () {
            yield* (
              input.finalizeEffect?.({ _tag: "Applied", result: appliedResult }) ?? Effect.void
            );
            return { _tag: "Applied" as const, result: appliedResult };
          }),
      },
      scheduler: schedulerRecording(scheduled),
      store,
    });

    yield* coordinator.reconcile(candidate.actionId, candidate.authorityIdentity.userId);
    yield* coordinator.reconcile(candidate.actionId, candidate.authorityIdentity.userId);
    yield* coordinator.reconcile(candidate.actionId, candidate.authorityIdentity.userId);
    expect(scheduled).toEqual([
      {
        delayMilliseconds: Integrations.initialActionReconciliationDelayMilliseconds,
        idempotent: false,
      },
      {
        delayMilliseconds: Integrations.initialActionReconciliationDelayMilliseconds,
        idempotent: false,
      },
    ]);
    expect(recorded).toEqual(new Set([`${candidate.actionId}:observed`]));
  }),
);

const candidate = {
  actionId: ActionId.make("gmail-action-coordinator"),
  allowancePeriodId: AllowancePeriodId.make("period-1"),
  connectionBinding,
  authorityIdentity: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("auth-session-1"),
    userId: UserId.make("user-1"),
  },
  input: {
    body: "Exact body",
    gmailResource: "primary",
    recipients: ["person@example.test"],
    subject: "Exact subject",
  },
  presentationId: ActionPresentationId.make("presentation-coordinator"),
} as const;

const appliedResult = {
  _tag: "IntegrationEffectCompleted",
  evidence: { providerLogId: "log-1", providerResourceId: "message-1" },
  manifestVersion: ManifestVersion.make("gmail-v1"),
  mutations: 1,
  operation: "GMAIL_SEND_EMAIL",
  toolkit: "gmail",
} as const;

const noAccounting: ImmediateGmailSend.Accounting = { record: () => Effect.void };

interface ScheduledInspection {
  readonly delayMilliseconds: number;
  readonly idempotent: boolean;
}

const schedulerRecording = (
  scheduled: Array<ScheduledInspection>,
): ImmediateGmailSend.Scheduler => ({
  schedule: (_actionId, _userId, delayMilliseconds, idempotent) =>
    Effect.sync(() => {
      scheduled.push({ delayMilliseconds, idempotent });
    }),
});

const memoryStore = () => {
  const approvalBindings = new Map<
    ActionPresentationId,
    ImmediateGmailSend.ApprovalConnectionBinding
  >();
  const contexts = new Map<ActionId, ImmediateGmailSend.Context>();
  const terminal = new Map<ActionId, ImmediateGmailSend.TerminalStatus>();
  let retainedOrdinal = 0;
  let settlementSequence = 0;
  const store = ImmediateGmailSend.make({
    deleteUser: (userId) =>
      Effect.sync(() => {
        for (const [actionId, context] of contexts) {
          if (context.authorityIdentity.userId === userId) contexts.delete(actionId);
        }
        for (const [actionId, status] of terminal) {
          if (status.userId === userId) terminal.delete(actionId);
        }
        for (const [presentationId, binding] of approvalBindings) {
          if (binding.userId === userId) approvalBindings.delete(presentationId);
        }
      }),
    listOpen: () => Effect.succeed([...contexts.values()]),
    listTerminal: (limit) => {
      const values = [...terminal.values()].sort(
        (left, right) => right.settlementSequence - left.settlementSequence,
      );
      return Effect.succeed(values.slice(0, limit));
    },
    read: (actionId) => Effect.succeed(contexts.get(actionId) ?? null),
    readApprovalBinding: (presentationId) =>
      Effect.succeed(approvalBindings.get(presentationId) ?? null),
    releaseApprovalBinding: (presentationId) =>
      Effect.sync(() => {
        approvalBindings.delete(presentationId);
      }),
    retain: (retainedCandidate) =>
      Effect.sync(() => {
        const retained =
          contexts.get(retainedCandidate.actionId) ??
          ({
            ...retainedCandidate,
            retainedAt: new Date(Date.UTC(2026, 7, 30, 12, 0, retainedOrdinal++)),
          } as const);
        contexts.set(retainedCandidate.actionId, retained);
        return retained;
      }),
    retainApprovalBinding: (binding) =>
      Effect.sync(() => {
        const retained = approvalBindings.get(binding.presentationId) ?? binding;
        approvalBindings.set(binding.presentationId, retained);
        return retained;
      }),
    settle: (context, status) =>
      Effect.sync(() => {
        contexts.delete(context.actionId);
        settlementSequence += 1;
        terminal.set(context.actionId, {
          actionId: context.actionId,
          presentationId: context.presentationId,
          settledAt: new Date(Date.UTC(2026, 7, 30, 13, 0, settlementSequence)),
          settlementSequence,
          status,
          userId: context.authorityIdentity.userId,
        });
        const stale = [...terminal.values()]
          .sort((left, right) => right.settlementSequence - left.settlementSequence)
          .slice(ImmediateGmailSend.maximumVisibleActions)
          .map((value) => value.actionId);
        stale.forEach((actionId) => terminal.delete(actionId));
      }),
  });
  return { contexts, store, terminal };
};

const durableStorageFake = () => {
  const records = new Map<string, unknown>();
  const batches: Array<ReadonlyArray<string>> = [];
  const list = async (options?: { readonly limit?: number; readonly prefix?: string }) => {
    const entries = [...records.entries()]
      .filter(([key]) => options?.prefix === undefined || key.startsWith(options.prefix))
      .sort(([left], [right]) => left.localeCompare(right));
    return new Map(options?.limit === undefined ? entries : entries.slice(0, options.limit));
  };
  const remove = async (keys: string | ReadonlyArray<string>) => {
    const owned = typeof keys === "string" ? [keys] : keys;
    if (typeof keys !== "string") batches.push(keys);
    owned.forEach((key) => records.delete(key));
    return owned.length;
  };
  const adapter = {
    delete: remove,
    get: async (key: string) => records.get(key),
    list,
    put: async (key: string, value: unknown) => {
      records.set(key, value);
    },
  };
  // SAFETY: The production adapter uses only these implemented Durable Object storage methods;
  // this fake preserves their Promise, transaction, key-order, and value contracts.
  const storage = {
    ...adapter,
    transaction: async <A>(run: (transaction: typeof adapter) => Promise<A>) => run(adapter),
  } as unknown as DurableObjectStorage;
  return { batches, records, storage };
};

const requiredInspection = (
  inspections: Array<Integrations.IntegrationActionInspection>,
): Integrations.IntegrationActionInspection => {
  const inspection = inspections.shift();
  if (inspection === undefined) throw new Error("Expected a queued integration inspection");
  return inspection;
};
