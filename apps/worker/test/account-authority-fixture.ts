import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { sessions, users } from "@osfo/db/schema/auth";
import { DateTime, Effect, Layer, Redacted } from "effect";

import * as AccountAuthorities from "../src/composition/account-authorities";
import * as Db from "../src/db";
import { UserId } from "../src/domain";
import { AdminActorId, AdminReason } from "../src/domain/account-administration";
import * as PhoneAccountAdapter from "../src/integrations/auth/phone-account";
import {
  TwilioVerify,
  phoneAccountVerificationLayerWithoutDependencies,
} from "../src/integrations/twilio/verify";
import * as DeletionCase from "../src/services/deletion-case";
import * as PhoneAccount from "../src/services/phone-account";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide -- The fixture owns real database and provider boundaries. */

/** Seeded User identity shared by account authority tests. */
export const userId = UserId.make("user-authority-1");

/** Seeded administrator identity shared by lifecycle transition tests. */
export const adminActorId = AdminActorId.make("admin-1");

/** Valid administrative reason shared by lifecycle transition tests. */
export const reason = AdminReason.make("Support reviewed the request");

/** Embedded PostgreSQL fixture type used by account authority tests. */
export type TestDatabaseFixture = Effect.Success<typeof makeTestDatabase>;

/** Composed narrow account authorities used by integration tests. */
export type Authorities = Effect.Success<typeof AccountAuthorities.make>;

/** Seeded account authority test resources supplied to one test. */
export interface AccountAuthorityFixture {
  readonly authorities: Authorities;
  readonly database: TestDatabaseFixture;
  readonly phoneAccounts: PhoneAccount.Interface;
  readonly phoneStore: PhoneAccount.StorePort;
  readonly twilio: {
    readonly code: string;
    readonly sent: Array<string>;
    readonly service: TwilioVerify["Service"];
  };
}

/** Run one test with isolated migrated PostgreSQL and account authorities. */
export const withAccountAuthorityFixture = <A, E>(
  use: (fixture: AccountAuthorityFixture) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.scoped(
    Effect.acquireUseRelease(
      makeTestDatabase,
      (database) =>
        Effect.gen(function* () {
          yield* applyMigrations(database.client).pipe(Effect.orDie);
          yield* seedUser(database.database);
          const twilio = makeTwilio();
          const base = Layer.mergeAll(
            BrowserCrypto.layer,
            Db.layerFromDatabase(database.database),
            Layer.succeed(TwilioVerify, twilio.service),
          );
          const authorities = yield* AccountAuthorities.make.pipe(Effect.provide(base));
          const phoneStore = yield* PhoneAccountAdapter.make.pipe(Effect.provide(base));
          const verification = yield* PhoneAccount.Verification.pipe(
            Effect.provide(
              phoneAccountVerificationLayerWithoutDependencies.pipe(Layer.provide(base)),
            ),
          );
          const phoneAccounts = yield* PhoneAccount.make.pipe(
            Effect.provideService(PhoneAccount.Store, phoneStore),
            Effect.provideService(PhoneAccount.Verification, verification),
            Effect.provideService(DeletionCase.Service, authorities.deletionCases),
          );
          return yield* use({ authorities, database, phoneAccounts, phoneStore, twilio });
        }),
      closeTestDatabase,
    ),
  );

const seedUser = (database: TestDatabaseFixture["database"]) =>
  Effect.promise(() =>
    database.transaction(async (transaction) => {
      await transaction.insert(users).values({
        email: "internal@phone-user.osfo.invalid",
        id: userId,
        name: "Osfo User",
        phoneNumber: "+14165550100",
        phoneNumberVerified: true,
      });
      await transaction.insert(sessions).values([
        {
          expiresAt: testDate("2026-09-01T00:00:00.000Z"),
          id: "auth-session-1",
          token: "token-1",
          updatedAt: testDate("2026-08-16T00:00:00.000Z"),
          userId,
        },
        {
          expiresAt: testDate("2026-09-01T00:00:00.000Z"),
          id: "auth-session-2",
          token: "token-2",
          updatedAt: testDate("2026-08-16T00:00:00.000Z"),
          userId,
        },
      ]);
    }),
  );

const makeTwilio = () => {
  const code = "123456";
  const sent: Array<string> = [];
  return {
    code,
    sent,
    service: TwilioVerify.of({
      sendCode: (phoneNumber) =>
        Effect.sync(() => {
          sent.push(phoneNumber);
        }),
      verifyCode: (_phoneNumber, submittedCode) =>
        Effect.succeed(Redacted.value(submittedCode) === code),
    }),
  };
};

/** Construct one deterministic UTC Date for account authority tests. */
export const testDate = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
