import { Effect, Schema } from "effect";

import type {
  ActionPresentation,
  ActionPresentationsFound,
  ApprovalDecisionAccepted,
} from "../agents/osfo/think-action-approvals";
import type { ActionApprovalSelection } from "./action-approvals";

export interface Decision {
  readonly decision: "approve" | "reject";
  readonly presentationId: string;
  readonly reason?: string | undefined;
}

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "ImmediateGmailApprovalsUnavailable",
  { message: Schema.String },
) {}

export interface Port {
  readonly decide: (decision: Decision) => Effect.Effect<ApprovalDecisionAccepted, Unavailable>;
  readonly list: Effect.Effect<ActionPresentationsFound, Unavailable>;
}

export const maximumVisibleApprovals = 50;
export const selection: ActionApprovalSelection = {
  maximum: maximumVisibleApprovals,
  select: (pending) => pending.descriptor.action === "gmailSendEmail",
};

/** Own the immediate-Gmail projection and exact decision fence over Think's Approval store. */
export const make = (port: Port) => {
  const list = Effect.fn("ImmediateGmailApprovals.list")(function* () {
    const found = yield* port.list;
    // Think returns durable-pause Approvals oldest-first from its created_at index.
    const selected = found.presentations
      .filter(isImmediateGmailApproval)
      .slice(0, maximumVisibleApprovals);
    return selected.map(project);
  });

  const decide = Effect.fn("ImmediateGmailApprovals.decide")(function* (decision: Decision) {
    const visible = yield* list();
    if (!visible.some(({ presentationId }) => presentationId === decision.presentationId)) {
      return yield* new Unavailable({ message: "The immediate Gmail Approval is not pending" });
    }
    const accepted = yield* port.decide(decision);
    return {
      decision: accepted.decision === "canceled" ? ("rejected" as const) : accepted.decision,
      presentationId: accepted.presentationId,
    };
  });

  return { decide, list };
};

const isImmediateGmailApproval = (presentation: ActionPresentation) =>
  presentation.operation === "integration.effect" &&
  presentation.actionDefinitionVersion === "osfo-gmail-send-v1";

const project = ({
  actionId,
  consequences,
  description,
  fields,
  presentationId,
  title,
}: ActionPresentation) => ({
  actionId,
  consequences,
  description,
  fields,
  presentationId,
  title,
});

export * as ImmediateGmailApprovals from "./immediate-gmail-approvals";
