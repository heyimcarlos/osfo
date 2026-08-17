import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { sessions, users } from "@osfo/db/schema/auth";
import { DateTime, Effect, Layer } from "effect";

import * as AccountAuthorities from "../src/composition/account-authorities";
import * as Db from "../src/db";
import { UserId } from "../src/domain";
import { AdminActorId, AdminReason } from "../src/domain/account-administration";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide -- The fixture owns its isolated PGlite boundary. */

/** Seeded User identity shared by account authority tests. */
export const userId = UserId.make("user-authority-1");

/** Seeded administrator identity shared by lifecycle transition tests. */
export const adminActorId = AdminActorId.make("admin-1");

/** Valid administrative reason shared by lifecycle transition tests. */
export const reason = AdminReason.make("Support reviewed the request");

/** Isolated PGlite fixture type used by account authority tests. */
export type TestDatabaseFixture = Effect.Success<typeof makeTestDatabase>;

/** Composed narrow account authorities used by integration tests. */
export type Authorities = Effect.Success<typeof AccountAuthorities.make>;

/** Seeded account authority test resources supplied to one test. */
export interface AccountAuthorityFixture {
  readonly authorities: Authorities;
  readonly database: TestDatabaseFixture;
}

/** Run one test with isolated migrated PGlite and account authorities. */
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
          const base = Layer.mergeAll(BrowserCrypto.layer, Db.layerFromDatabase(database.database));
          const authorities = yield* AccountAuthorities.make.pipe(Effect.provide(base));
          return yield* use({ authorities, database });
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

/** Construct one deterministic UTC Date for account authority tests. */
export const testDate = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
