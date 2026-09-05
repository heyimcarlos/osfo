/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect, vitest/no-standalone-expect -- Fixed transport timestamps and Effect assertions make the handler projection deterministic. */
import { describe, expect, it } from "@effect/vitest";
import { Auth, CurrentUser, ScheduledEmailApprovalDecision, ScheduledEmailsGroup } from "@osfo/api";
import { agents } from "@osfo/db/schema/agents";
import { users } from "@osfo/db/schema/auth";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { vi } from "vitest";

import {
  ActionPresentation,
  ActionPresentationId,
  ActionPresentationsFound,
  ApprovalDecisionAccepted,
} from "../agents/osfo/think-action-approvals";
import { Db } from "../db";
import { ActionId } from "../domain/action-execution";
import { ScheduledEmail } from "../services/scheduled-email";
import { ScheduledEmailFollowUp } from "../services/scheduled-email-follow-up";
import { ScheduledEmailHandlers, listApprovals, projectNotification } from "./scheduled-emails";

describe("Scheduled Email notification projection", () => {
  it.each([
    { expectedOutcome: "applied", expectedState: "success" },
    { expectedOutcome: "notApplied", expectedState: "failure" },
  ] as const)(
    "returns late $expectedOutcome provider truth through the authenticated API",
    ({ expectedOutcome, expectedState }) => {
      const deliveredAt = new Date("2026-08-29T12:00:30.000Z");
      const workflowId = ScheduledEmail.WorkflowId.make(`scheduled-email:${expectedOutcome}`);

      expect(
        projectNotification({
          acceptedAt: deliveredAt,
          claimedAt: new Date("2026-08-29T12:00:00.000Z"),
          sendOutcome: expectedOutcome,
          state: expectedState,
          workflowId,
        }),
      ).toEqual({ deliveredAt, sendOutcome: expectedOutcome, state: expectedState, workflowId });
    },
  );

  it.effect("requests only Scheduled Email Action presentations from the Agent", () =>
    Effect.gen(function* () {
      const selections: Array<string | undefined> = [];
      const scheduled = ActionPresentation.make({
        actionDefinitionVersion: "osfo-scheduled-email-start-v1",
        actionId: ActionId.make("scheduled-action"),
        consequences: ["Schedule one email."],
        description: "Schedule the exact email shown here.",
        fields: [],
        operation: "integration.effect",
        presentationId: ActionPresentationId.make("scheduled-presentation"),
        title: "Schedule email",
      });
      const result = yield* listApprovals(
        {
          decideActionApproval: () => Promise.resolve(null),
          listActionPresentations: (_agentId, _actor, selection) => {
            selections.push(selection);
            return Promise.resolve(ActionPresentationsFound.make({ presentations: [scheduled] }));
          },
        },
        "agent-1",
        {
          authSessionExpiresAt: new Date("2026-08-30T00:00:00.000Z"),
          authSessionId: "session-1",
          userId: "user-1",
        },
      );

      expect(selections).toEqual(["scheduled-email"]);
      expect(result.items.map(({ presentationId }) => presentationId)).toEqual([
        "scheduled-presentation",
      ]);
    }),
  );
});

const currentUser = {
  authSessionExpiresAt: new Date("2026-08-30T00:00:00.000Z"),
  authSessionId: "session-1",
  userId: "user-1",
};
type DirectoryStub = ReturnType<ScheduledEmailHandlers.Bindings["OSFO_DIRECTORY"]["getByName"]>;

const scheduledPresentation = ActionPresentation.make({
  actionDefinitionVersion: "osfo-scheduled-email-start-v1",
  actionId: ActionId.make("scheduled-action"),
  consequences: ["Schedule one email."],
  description: "Schedule the exact email shown here.",
  fields: [],
  operation: "integration.effect",
  presentationId: ActionPresentationId.make("scheduled-presentation"),
  title: "Schedule email",
});

describe("Scheduled Email decision HTTP handler", () => {
  for (const scenario of [
    { name: "missing presentation", presentations: [] },
    {
      name: "different presentation identity",
      presentations: [
        { ...scheduledPresentation, presentationId: ActionPresentationId.make("other") },
      ],
    },
    {
      name: "another Action definition",
      presentations: [
        { ...scheduledPresentation, actionDefinitionVersion: "osfo-reminder-create-v1" },
      ],
    },
    {
      name: "another operation",
      presentations: [{ ...scheduledPresentation, operation: "reminder.create" }],
    },
  ]) {
    it.effect(`rejects ${scenario.name} without invoking a decision`, () =>
      Effect.gen(function* () {
        const decideActionApproval = vi.fn<DirectoryStub["decideActionApproval"]>(() =>
          Promise.resolve(null),
        );
        const app = yield* makeApp({
          decideActionApproval,
          listActionPresentations: () =>
            Promise.resolve(
              ActionPresentationsFound.make({ presentations: scenario.presentations }),
            ),
        });

        const response = yield* decide(app);

        expect(response.status).toBe(503);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          _tag: "ScheduledEmailsUnavailable",
          message: "Scheduled Email controls are temporarily unavailable. Please try again.",
        });
        expect(decideActionApproval).not.toHaveBeenCalled();
      }),
    );
  }

  for (const scenario of [
    { name: "rejected lookup", lookup: () => Promise.reject(new Error("lookup failed")) },
    { name: "malformed lookup", lookup: () => Promise.resolve({ presentations: [] }) },
  ]) {
    it.effect(`fails a ${scenario.name} without invoking a decision`, () =>
      Effect.gen(function* () {
        const decideActionApproval = vi.fn<DirectoryStub["decideActionApproval"]>(() =>
          Promise.resolve(null),
        );
        const app = yield* makeApp({
          decideActionApproval,
          listActionPresentations: scenario.lookup,
        });

        const response = yield* decide(app);

        expect(response.status).toBe(503);
        expect(decideActionApproval).not.toHaveBeenCalled();
      }),
    );
  }

  for (const decision of ["approve", "reject"] as const) {
    it.effect(`invokes ${decision} once after the selected lookup resolves`, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const selected = yield* Deferred.make<ActionPresentationsFound>();
        const calls: Array<string> = [];
        const listActionPresentations = vi.fn<DirectoryStub["listActionPresentations"]>(() => {
          calls.push("selection started");
          // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- The Directory RPC stub must expose the test-controlled Deferred as a Promise.
          return Effect.runPromise(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(selected)),
              Effect.tap(() => Effect.sync(() => calls.push("selection resolved"))),
            ),
          );
        });
        const decideActionApproval = vi.fn<DirectoryStub["decideActionApproval"]>(() => {
          calls.push("decision");
          return Promise.resolve(
            ApprovalDecisionAccepted.make({
              decision: decision === "approve" ? "approved" : "canceled",
              presentationId: scheduledPresentation.presentationId,
            }),
          );
        });
        const app = yield* makeApp({ decideActionApproval, listActionPresentations });
        const responseFiber = yield* decide(app, decision).pipe(Effect.forkScoped);

        yield* Deferred.await(started);
        yield* Effect.yieldNow;
        const decisionsBeforeSelection = decideActionApproval.mock.calls.length;
        yield* Deferred.succeed(
          selected,
          ActionPresentationsFound.make({ presentations: [scheduledPresentation] }),
        );
        const response = yield* Fiber.join(responseFiber);

        expect(decisionsBeforeSelection).toBe(0);
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          decision: decision === "approve" ? "approved" : "rejected",
          presentationId: scheduledPresentation.presentationId,
        });
        expect(calls).toEqual(["selection started", "selection resolved", "decision"]);
        expect(listActionPresentations).toHaveBeenCalledExactlyOnceWith(
          "agent-1",
          {
            _tag: "AuthSession",
            authSessionId: currentUser.authSessionId,
            expiresAt: currentUser.authSessionExpiresAt.toISOString(),
            userId: currentUser.userId,
          },
          "scheduled-email",
        );
        expect(decideActionApproval).toHaveBeenCalledExactlyOnceWith("agent-1", {
          actor: {
            _tag: "AuthSession",
            authSessionId: currentUser.authSessionId,
            expiresAt: currentUser.authSessionExpiresAt.toISOString(),
            userId: currentUser.userId,
          },
          decision,
          presentationId: scheduledPresentation.presentationId,
          reason: "Reviewed the email",
        });
      }),
    );
  }
});

const makeApp = (stub: DirectoryStub) =>
  Effect.gen(function* () {
    const fixture = yield* Effect.acquireRelease(makeTestDatabase, closeTestDatabase);
    yield* applyMigrations(fixture.client);
    yield* Effect.promise(() =>
      fixture.database.insert(users).values({
        email: "scheduled-handler@example.test",
        id: currentUser.userId,
        name: "Scheduled Email Test",
      }),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(agents).values({
        agent_id: "agent-1",
        created_at: "2026-08-29T12:00:00.000Z",
        user_id: currentUser.userId,
      }),
    );
    const handlers = ScheduledEmailHandlers.layer({
      OSFO_DIRECTORY: { getByName: () => stub },
    }).pipe(
      Layer.provide(Db.layerFromDatabase(fixture.database)),
      Layer.provide(Layer.mock(ScheduledEmailFollowUp.Service, {})),
    );
    return yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(HttpApi.make("osfo").add(ScheduledEmailsGroup)).pipe(
            Layer.provide(handlers),
            Layer.provide(
              Layer.succeed(
                Auth,
                Auth.of((effect) => Effect.provideService(effect, CurrentUser, currentUser)),
              ),
            ),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (app) => Effect.promise(() => app.dispose()),
    );
  });

const decide = (
  app: Effect.Success<ReturnType<typeof makeApp>>,
  decision: "approve" | "reject" = "approve",
) =>
  Effect.gen(function* () {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ScheduledEmailApprovalDecision))({
      decision,
      presentationId: scheduledPresentation.presentationId,
      reason: "Reviewed the email",
    });
    return yield* Effect.promise(() =>
      app.handler(
        new Request("http://localhost/v1/scheduled-emails/approvals/decision", {
          body,
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      ),
    );
  });
