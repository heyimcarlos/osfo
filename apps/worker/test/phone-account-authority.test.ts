import { BrowserCrypto } from "@effect/platform-browser";
import { describe, expect, it } from "@effect/vitest";
import { users } from "@osfo/db/schema/auth";
import { deletionCases } from "@osfo/db/schema/user-lifecycle";
import { Effect, Exit, Layer, Redacted } from "effect";

import { Db } from "../src/db";
import { UserId } from "../src/domain";
import { AuthSessionId } from "../src/domain/auth-session";
import { PhoneNumber } from "../src/domain/phone-account";
import { PhoneAccountAdapter } from "../src/integrations/auth/phone-account";
import {
  TwilioVerify,
  phoneAccountVerificationLayerWithoutDependencies,
} from "../src/integrations/twilio/verify";
import { DeletionCase } from "../src/services/deletion-case";
import { PhoneAccount } from "../src/services/phone-account";
import type { AccountAuthorityFixture } from "./account-authority-fixture";
import {
  adminActorId,
  reason,
  userId,
  withAccountAuthorityFixture,
} from "./account-authority-fixture";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/strict-effect-provide -- Tests assert tagged outcomes and the local fixture is the Phone Account composition entry point. */

describe("Phone Account authority", () => {
  it.effect("replaces one Phone Account and atomically revokes every AuthSession", () =>
    withPhoneAccountFixture(({ authorities, phoneAccounts, twilio }) =>
      Effect.gen(function* () {
        const phoneNumber = PhoneNumber.make("+14165550199");
        const started = yield* phoneAccounts.beginReplacement({ phoneNumber, userId });
        const replaced = yield* phoneAccounts.completeReplacement({
          code: Redacted.make(twilio.code),
          phoneNumber,
          userId,
        });
        const firstSession = yield* authorities.authSessions.inspect(
          userId,
          AuthSessionId.make("auth-session-1"),
        );
        const secondSession = yield* authorities.authSessions.inspect(
          userId,
          AuthSessionId.make("auth-session-2"),
        );

        expect(started).toEqual({ _tag: "PhoneReplacementStarted" });
        expect(twilio.sent).toEqual([phoneNumber]);
        expect(replaced).toEqual({ _tag: "PhoneAccountReplaced" });
        expect(firstSession._tag).toBe("RevokedAuthSession");
        expect(secondSession._tag).toBe("RevokedAuthSession");
      }),
    ),
  );

  it.effect("requires manual support for a collision and rejected code", () =>
    withPhoneAccountFixture(({ database, phoneAccounts }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          database.database.insert(users).values({
            email: "collision@phone-user.osfo.invalid",
            id: "user-collision",
            name: "Osfo User",
            phoneNumber: "+14165550188",
            phoneNumberVerified: true,
          }),
        );
        const collision = yield* phoneAccounts.beginReplacement({
          phoneNumber: PhoneNumber.make("+14165550188"),
          userId,
        });
        const rejected = yield* phoneAccounts
          .completeReplacement({
            code: Redacted.make("000000"),
            phoneNumber: PhoneNumber.make("+14165550177"),
            userId,
          })
          .pipe(Effect.exit);

        expect(collision._tag).toBe("ManualSupportRequired");
        expect(Exit.isFailure(rejected)).toBe(true);
        expect(String(rejected)).not.toContain("internal@phone-user.osfo.invalid");
      }),
    ),
  );

  it.effect("returns manual support for concurrent replacement collisions", () =>
    withPhoneAccountFixture(({ database, phoneAccounts, twilio }) =>
      Effect.gen(function* () {
        const otherUserId = UserId.make("user-authority-2");
        const replacement = PhoneNumber.make("+14165550155");
        yield* Effect.promise(() =>
          database.database.insert(users).values({
            email: "other@phone-user.osfo.invalid",
            id: otherUserId,
            name: "Other Osfo User",
            phoneNumber: "+14165550111",
            phoneNumberVerified: true,
          }),
        );
        const results = yield* Effect.all(
          [
            phoneAccounts.completeReplacement({
              code: Redacted.make(twilio.code),
              phoneNumber: replacement,
              userId,
            }),
            phoneAccounts.completeReplacement({
              code: Redacted.make(twilio.code),
              phoneNumber: replacement,
              userId: otherUserId,
            }),
          ],
          { concurrency: "unbounded" },
        );

        // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 has no toSorted, and this new local array is safe to mutate.
        expect(results.map((result) => result._tag).sort()).toEqual([
          "ManualSupportRequired",
          "PhoneAccountReplaced",
        ]);
      }),
    ),
  );

  it.effect("checks the Deletion Case fence inside replacement", () =>
    withPhoneAccountFixture(({ database, phoneStore }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          database.database.insert(deletionCases).values({
            deletion_case_id: "deletion-fence-1",
            reason,
            requested_by_admin_id: adminActorId,
            user_id: userId,
          }),
        );
        const result = yield* phoneStore.replaceAndRevokeSessions(
          userId,
          PhoneNumber.make("+14165550166"),
        );

        expect(result).toBe("deletion-requested");
      }),
    ),
  );

  it.effect("routes account recovery to manual support", () =>
    withPhoneAccountFixture(({ phoneAccounts }) =>
      Effect.gen(function* () {
        const result = yield* phoneAccounts.requestRecovery;

        expect(result).toEqual({
          _tag: "ManualSupportRequired",
          message: "Account recovery requires manual support.",
        });
      }),
    ),
  );
});

const withPhoneAccountFixture = <A, E>(
  use: (
    fixture: AccountAuthorityFixture & {
      readonly phoneAccounts: PhoneAccount.Interface;
      readonly phoneStore: PhoneAccount.StorePort;
      readonly twilio: ReturnType<typeof makeTwilio>;
    },
  ) => Effect.Effect<A, E>,
) =>
  withAccountAuthorityFixture((fixture) =>
    Effect.scoped(
      Effect.gen(function* () {
        const twilio = makeTwilio();
        const base = Layer.mergeAll(
          BrowserCrypto.layer,
          Db.layerFromDatabase(fixture.database.database),
          Layer.succeed(TwilioVerify.Service, twilio.service),
        );
        const phoneStore = yield* PhoneAccountAdapter.make.pipe(Effect.provide(base));
        const verification = yield* PhoneAccount.Verification.pipe(
          Effect.provide(
            phoneAccountVerificationLayerWithoutDependencies.pipe(Layer.provide(base)),
          ),
        );
        const phoneAccounts = yield* PhoneAccount.make.pipe(
          Effect.provideService(PhoneAccount.Store, phoneStore),
          Effect.provideService(PhoneAccount.Verification, verification),
          Effect.provideService(DeletionCase.Service, fixture.authorities.deletionCases),
        );
        return yield* use({ ...fixture, phoneAccounts, phoneStore, twilio });
      }),
    ),
  );

const makeTwilio = () => {
  const code = "123456";
  const sent: Array<string> = [];
  return {
    code,
    sent,
    service: TwilioVerify.Service.of({
      sendCode: (phoneNumber) =>
        Effect.sync(() => {
          sent.push(phoneNumber);
        }),
      verifyCode: (_phoneNumber, submittedCode) =>
        Effect.succeed(Redacted.value(submittedCode) === code),
    }),
  };
};
