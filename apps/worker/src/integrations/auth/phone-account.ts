import { createPhoneAccountAuthority } from "@osfo/auth";
import { deletionCases } from "@osfo/db/schema/user-lifecycle";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";

import * as Db from "../../db";
import * as PhoneAccount from "../../services/phone-account";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Effect tags and the Drizzle transaction fence require these forms. */

/** Build the Phone Account Store adapter from the request-scoped @osfo/auth capability. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;
  const authority = createPhoneAccountAuthority(database, {
    replacementBlocked: async (transaction, userId) => {
      const [deletionCase] = await transaction
        .select({ deletionCaseId: deletionCases.deletionCaseId })
        .from(deletionCases)
        .where(eq(deletionCases.userId, userId))
        .limit(1);
      return deletionCase !== undefined;
    },
  });
  return PhoneAccount.Store.of({
    inspectReplacement: (userId, phoneNumber) =>
      Effect.tryPromise({
        try: () => authority.inspectReplacement(userId, phoneNumber),
        catch: (cause) => unavailable("inspectReplacement", cause),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PhoneAccount.ReplacementFacts)),
        Effect.mapError((cause) =>
          cause._tag === "PhoneAccountUnavailable"
            ? cause
            : unavailable("inspectReplacement", cause),
        ),
      ),
    replaceAndRevokeSessions: (userId, phoneNumber) =>
      Effect.tryPromise({
        try: () => authority.replaceAndRevokeSessions(userId, phoneNumber),
        catch: (cause) => unavailable("replaceAndRevokeSessions", cause),
      }),
  });
});

/** Phone Account Store Layer backed by @osfo/auth. */
export const layerWithoutDependencies = Layer.effect(PhoneAccount.Store, make);

const unavailable = (operation: string, cause: unknown) =>
  new PhoneAccount.PhoneAccountUnavailable({
    cause,
    message: `The Phone Account authority could not complete ${operation}`,
    operation,
  });
