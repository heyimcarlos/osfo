/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect, vitest/no-standalone-expect -- Fixed transport timestamps and Effect assertions exercise the Directory boundary. */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import {
  ActionPresentation,
  ActionPresentationId,
  ActionPresentationsFound,
  ApprovalDecisionAccepted,
} from "../agents/osfo/think-action-approvals";
import { ActionId } from "../domain/action-execution";
import { decideApproval, listApprovals } from "./reminders";

const currentUser = {
  authSessionExpiresAt: new Date("2026-09-06T00:00:00.000Z"),
  authSessionId: "session-1",
  userId: "user-1",
};
const reminder = ActionPresentation.make({
  actionDefinitionVersion: "osfo-reminder-manage-v1",
  actionId: ActionId.make("reminder-action"),
  consequences: ["Create and activate this exact Reminder."],
  description: "Exact Reminder",
  fields: [{ label: "Body", name: "body", value: "Private reminder body" }],
  operation: "reminder.manage",
  presentationId: ActionPresentationId.make("reminder-presentation"),
  title: "Create Reminder",
});

describe("Reminder Approval handler", () => {
  it.effect(
    "requests the Reminder selection and preserves exact fields and authenticated actor",
    () =>
      Effect.gen(function* () {
        const calls: Array<ReadonlyArray<unknown>> = [];
        const result = yield* listApprovals(
          {
            decideActionApproval: () => Promise.resolve(null),
            listActionPresentations: (...args) => {
              calls.push(args);
              return Promise.resolve(
                ActionPresentationsFound.make({
                  presentations: [reminder, { ...reminder, operation: "integration.effect" }],
                }),
              );
            },
          },
          "agent-1",
          currentUser,
        );
        expect(calls).toEqual([
          [
            "agent-1",
            {
              _tag: "AuthSession",
              authSessionId: "session-1",
              expiresAt: "2026-09-06T00:00:00.000Z",
              userId: "user-1",
            },
            "reminder",
          ],
        ]);
        expect(result.items).toEqual([
          {
            actionId: reminder.actionId,
            consequences: reminder.consequences,
            description: reminder.description,
            fields: reminder.fields,
            presentationId: reminder.presentationId,
            title: reminder.title,
          },
        ]);
      }),
  );

  it.effect.each([
    { name: "missing or resolved", presentations: [] },
    { name: "wrong operation", presentations: [{ ...reminder, operation: "integration.effect" }] },
    {
      name: "wrong definition",
      presentations: [{ ...reminder, actionDefinitionVersion: "other-v1" }],
    },
    {
      name: "changed presentation",
      presentations: [{ ...reminder, presentationId: ActionPresentationId.make("replacement") }],
    },
  ])("does not invoke decision RPC for $name", ({ presentations }) =>
    Effect.gen(function* () {
      let decisions = 0;
      const result = yield* decideApproval(
        {
          decideActionApproval: () => {
            decisions++;
            return Promise.resolve(null);
          },
          listActionPresentations: () =>
            Promise.resolve(ActionPresentationsFound.make({ presentations })),
        },
        "agent-1",
        currentUser,
        { decision: "approve", presentationId: reminder.presentationId },
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(decisions).toBe(0);
    }),
  );

  it.effect.each(["approve", "reject"] as const)(
    "defers %s until the selected list succeeds",
    (decision) =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const program = decideApproval(
          {
            listActionPresentations: () => {
              calls.push("list");
              return Promise.resolve(ActionPresentationsFound.make({ presentations: [reminder] }));
            },
            decideActionApproval: (_agent, request) => {
              calls.push("decision");
              expect(request.actor.userId).toBe(currentUser.userId);
              return Promise.resolve(
                ApprovalDecisionAccepted.make({
                  decision: decision === "approve" ? "approved" : "rejected",
                  presentationId: reminder.presentationId,
                }),
              );
            },
          },
          "agent-1",
          currentUser,
          { decision, presentationId: reminder.presentationId },
        );
        expect(calls).toEqual([]);
        const result = yield* program;
        expect(calls).toEqual(["list", "decision"]);
        expect(result.decision).toBe(decision === "approve" ? "approved" : "rejected");
      }),
  );

  it.effect("fails closed when current Agent authority is revoked after listing", () =>
    Effect.gen(function* () {
      const result = yield* decideApproval(
        {
          listActionPresentations: () =>
            Promise.resolve(ActionPresentationsFound.make({ presentations: [reminder] })),
          decideActionApproval: () => Promise.resolve({ _tag: "ApprovalActorUnauthorized" }),
        },
        "agent-1",
        currentUser,
        { decision: "approve", presentationId: reminder.presentationId },
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  );
});
