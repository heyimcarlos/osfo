/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect Vitest generators. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ActionId } from "../domain/action-execution";
import {
  ActionPresentationId,
  ActionPresentationsFound,
  ApprovalDecisionAccepted,
} from "../agents/osfo/think-action-approvals";
import { ImmediateGmailApprovals } from "./immediate-gmail-approvals";

it.effect(
  "projects only the newest fifty immediate Gmail Approvals and decides an exact item",
  () =>
    Effect.gen(function* () {
      const decisions: Array<ImmediateGmailApprovals.Decision> = [];
      const gmail = Array.from({ length: 52 }, (_, index) => presentation(index));
      const approvals = ImmediateGmailApprovals.make({
        decide: (decision) =>
          Effect.sync(() => {
            decisions.push(decision);
            return ApprovalDecisionAccepted.make({
              decision: decision.decision === "approve" ? "approved" : "rejected",
              presentationId: ActionPresentationId.make(decision.presentationId),
            });
          }),
        list: Effect.succeed(
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
      expect(visible.at(0)?.presentationId).toBe("gmail-presentation-51");
      expect(visible.at(-1)?.presentationId).toBe("gmail-presentation-2");
      expect(
        yield* approvals.decide({ decision: "reject", presentationId: "gmail-presentation-51" }),
      ).toEqual({ decision: "rejected", presentationId: "gmail-presentation-51" });
      expect(decisions).toEqual([{ decision: "reject", presentationId: "gmail-presentation-51" }]);
      expect(
        yield* approvals
          .decide({ decision: "approve", presentationId: "gmail-presentation-1" })
          .pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "ImmediateGmailApprovalsUnavailable" } });
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
