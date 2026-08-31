/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect Vitest generators. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ActionId } from "../domain/action-execution";
import { UserId } from "../domain";
import {
  ActionPresentationId,
  ActionPresentationsFound,
  ApprovalDecisionAccepted,
} from "../agents/osfo/think-action-approvals";
import { ImmediateGmailApprovals } from "./immediate-gmail-approvals";
import { IntegrationConnectionBinding } from "./integrations";

it.effect("drains the oldest fifty immediate Gmail Approvals so later items become reachable", () =>
  Effect.gen(function* () {
    const decisions: Array<ImmediateGmailApprovals.Decision> = [];
    let gmail = Array.from({ length: 52 }, (_, index) => presentation(index));
    const approvals = ImmediateGmailApprovals.make({
      decide: (decision) =>
        Effect.sync(() => {
          decisions.push(decision);
          return ApprovalDecisionAccepted.make({
            decision: decision.decision === "approve" ? "approved" : "rejected",
            presentationId: ActionPresentationId.make(decision.presentationId),
          });
        }),
      list: Effect.sync(() =>
        ActionPresentationsFound.make({
          presentations: [
            ...gmail,
            { ...presentation(53), actionDefinitionVersion: "osfo-scheduled-email-start-v1" },
          ],
        }),
      ),
    });

    const visible = yield* approvals.list();
    expect(visible).toHaveLength(ImmediateGmailApprovals.maximumVisibleApprovals);
    expect(visible.at(0)?.presentationId).toBe("gmail-presentation-0");
    expect(visible.at(-1)?.presentationId).toBe("gmail-presentation-49");
    expect(
      yield* approvals.decide({ decision: "reject", presentationId: "gmail-presentation-0" }),
    ).toEqual({ decision: "rejected", presentationId: "gmail-presentation-0" });
    gmail = gmail.slice(1);
    const progressed = yield* approvals.list();
    expect(progressed.at(-1)?.presentationId).toBe("gmail-presentation-50");
    expect(decisions).toEqual([{ decision: "reject", presentationId: "gmail-presentation-0" }]);
    expect(
      yield* approvals
        .decide({ decision: "approve", presentationId: "gmail-presentation-51" })
        .pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: "ImmediateGmailApprovalsUnavailable" } });
  }),
);

it.effect("leaves the first presentation retryable until connection evidence succeeds", () =>
  Effect.gen(function* () {
    const connectionBinding = IntegrationConnectionBinding.make("a".repeat(64));
    const retained: Array<IntegrationConnectionBinding | null> = [];
    let attempts = 0;
    const inspect = () => {
      attempts += 1;
      return attempts === 1
        ? Effect.fail("transient provider outage" as const)
        : Effect.succeed({
            _tag: "IntegrationConnectionConnected" as const,
            connectionBinding,
            toolkit: "gmail",
            userId: UserId.make("user-1"),
          });
    };
    const present = () =>
      ImmediateGmailApprovals.connectionBindingForPresentation(inspect()).pipe(
        Effect.tap((binding) =>
          Effect.sync(() => {
            retained.push(binding);
          }),
        ),
      );

    expect(yield* present().pipe(Effect.result)).toMatchObject({
      failure: "transient provider outage",
    });
    expect(retained).toEqual([]);
    expect(yield* present()).toBe(connectionBinding);
    expect(retained).toEqual([connectionBinding]);
  }),
);

const presentation = (index: number) => ({
  actionDefinitionVersion: "osfo-gmail-send-v1",
  actionId: ActionId.make(`gmail-action-${index}`),
  consequences: ["This sends one external message immediately."],
  description: "Send the exact Gmail message shown.",
  fields: [
    { label: "Gmail mailbox", name: "gmailResource", value: "primary" },
    { label: "Integration manifest", name: "manifestVersion", value: "gmail-v1" },
    { label: "Recipients", name: "recipients", value: '["person@example.test"]' },
    { label: "Subject", name: "subject", value: `Exact subject ${index}` },
    { label: "Message", name: "body", value: `Exact body ${index}` },
  ],
  operation: "integration.effect",
  presentationId: ActionPresentationId.make(`gmail-presentation-${index}`),
  title: "Send Gmail message",
});
