import { Effect, Schema } from "effect";

import type { AllowanceItem, AllowanceSource } from "../domain/allowance";
import type { ScheduledEmail } from "./scheduled-email";

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "ScheduledEmailAccountingUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["gmailSend", "workflowStart"]),
  },
) {}

export class PersistenceUnavailable extends Schema.TaggedError<PersistenceUnavailable>()(
  "ScheduledEmailAccountingPersistenceUnavailable",
  { cause: Schema.Defect() },
) {}

export interface Port {
  readonly recordLegacy: (
    allowancePeriodId: ScheduledEmail.Record["allowancePeriodId"],
    source: AllowanceSource,
    items: ReadonlyArray<AllowanceItem>,
  ) => Effect.Effect<void, PersistenceUnavailable>;
}

export interface Interface {
  readonly recordSendOutcome: (email: ScheduledEmail.Record) => Effect.Effect<void, Unavailable>;
  readonly recordWorkflowStart: (email: ScheduledEmail.Record) => Effect.Effect<void, Unavailable>;
}

/** Record launch counters only; gmail-v1 declares zero marginal provider cost. */
export const make = (port: Port): Interface => ({
  recordSendOutcome: (email) => {
    if (
      email.planPolicyVersion !== "launch-v1" ||
      (email.sendOutcome !== "applied" && email.sendOutcome !== "ambiguous")
    ) {
      return Effect.void;
    }
    return record(
      port,
      email,
      { sourceId: email.actionId, sourceType: "integrationAction" },
      [{ allowanceKind: "gmailSends", basis: "conservative", quantity: 1n }],
      "gmailSend",
    );
  },
  recordWorkflowStart: (email) =>
    email.planPolicyVersion !== "launch-v1"
      ? Effect.void
      : record(
          port,
          email,
          { sourceId: email.workflowId, sourceType: "workflow" },
          [{ allowanceKind: "workflowStarts", basis: "known_at_start", quantity: 1n }],
          "workflowStart",
        ),
});

const record = (
  port: Port,
  email: ScheduledEmail.Record,
  source: AllowanceSource,
  items: ReadonlyArray<AllowanceItem>,
  operation: Unavailable["operation"],
) =>
  port.recordLegacy(email.allowancePeriodId, source, items).pipe(
    Effect.mapError(
      (cause) =>
        new Unavailable({
          cause,
          message: "Scheduled Email accounting could not be retained",
          operation,
        }),
    ),
  );

export * as ScheduledEmailAccounting from "./scheduled-email-accounting";
