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
import { decideApproval, listApprovals } from "./browser-approvals";

const currentUser = {
  authSessionExpiresAt: new Date("2026-09-06T00:00:00.000Z"),
  authSessionId: "session-1",
  userId: "user-1",
};
const browser = ActionPresentation.make({
  actionDefinitionVersion: "osfo-browser-effect-v1",
  actionId: ActionId.make("browser-action"),
  consequences: ["Create and activate this exact browser interaction."],
  description: "Exact browser interaction",
  fields: [{ label: "Destination", name: "url", value: "https://portal.example.test/book" }],
  operation: "browser.effect",
  presentationId: ActionPresentationId.make("browser-presentation"),
  title: "Create browser interaction",
});

describe("browser interaction Approval handler", () => {
  it.effect(
    "requests the browser interaction selection and preserves exact fields and authenticated actor",
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
                  presentations: [browser, { ...browser, operation: "integration.effect" }],
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
            "browser",
          ],
        ]);
        expect(result.items).toEqual([
          {
            actionId: browser.actionId,
            consequences: browser.consequences,
            description: browser.description,
            fields: browser.fields,
            presentationId: browser.presentationId,
            title: browser.title,
          },
        ]);
      }),
  );

  it.effect.each([
    { name: "missing or resolved", presentations: [] },
    { name: "wrong operation", presentations: [{ ...browser, operation: "integration.effect" }] },
    {
      name: "wrong definition",
      presentations: [{ ...browser, actionDefinitionVersion: "other-v1" }],
    },
    {
      name: "changed presentation",
      presentations: [{ ...browser, presentationId: ActionPresentationId.make("replacement") }],
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
        { decision: "approve", presentationId: browser.presentationId },
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
              return Promise.resolve(ActionPresentationsFound.make({ presentations: [browser] }));
            },
            decideActionApproval: (_agent, request) => {
              calls.push("decision");
              expect(request.actor.userId).toBe(currentUser.userId);
              return Promise.resolve(
                ApprovalDecisionAccepted.make({
                  decision: decision === "approve" ? "approved" : "rejected",
                  presentationId: browser.presentationId,
                }),
              );
            },
          },
          "agent-1",
          currentUser,
          { decision, presentationId: browser.presentationId },
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
            Promise.resolve(ActionPresentationsFound.make({ presentations: [browser] })),
          decideActionApproval: () => Promise.resolve({ _tag: "ApprovalActorUnauthorized" }),
        },
        "agent-1",
        currentUser,
        { decision: "approve", presentationId: browser.presentationId },
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  );
});
