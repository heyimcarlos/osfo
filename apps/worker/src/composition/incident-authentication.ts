import type { Database } from "@osfo/db";
import { users } from "@osfo/db/schema/auth";
import { and, eq, isNotNull } from "drizzle-orm";
import { Effect } from "effect";

import { IncidentControlsPostgres } from "../integrations/postgres/incident-controls";
import { TwilioVerify } from "../integrations/twilio/verify";

/** Existing Users retain authentication access to deletion during an incident. */
export const sendCode = (
  database: Database,
  send: TwilioVerify.Interface["sendCode"],
): TwilioVerify.Interface["sendCode"] =>
  Effect.fn("IncidentAuthentication.sendCode")(function* (phoneNumber) {
    const registered = yield* Effect.tryPromise({
      try: () =>
        database
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.phoneNumber, phoneNumber),
              eq(users.phoneNumberVerified, true),
              isNotNull(users.registrationCompletedAt),
            ),
          )
          .limit(1),
      catch: () =>
        new TwilioVerify.TwilioVerifyUnavailable({
          message: "Phone verification is temporarily unavailable",
          operation: "sendCode",
        }),
    });
    if (registered.length === 0) {
      const controls = IncidentControlsPostgres.makeFromDatabase(database);
      const permitted = yield* controls
        .check("newIngress")
        .pipe(
          Effect.andThen(controls.check("newCostlyWork")),
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        );
      // Preserve the same accepted response so the switch cannot reveal registered phone numbers.
      if (!permitted) return;
    }
    yield* send(phoneNumber);
  });

export * as IncidentAuthentication from "./incident-authentication";
