import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { describe, expect, it } from "@effect/vitest";
import type { Database } from "@osfo/db";
import { users } from "@osfo/db/schema/auth";
import { Effect, Layer, Redacted } from "effect";

import * as AccountAuthorities from "../src/composition/account-authorities";
import * as Db from "../src/db";
import { UserId } from "../src/domain";
import { AdminActorId, AdminReason } from "../src/domain/account-administration";
import { PhoneNumber } from "../src/domain/phone-account";
import * as PhoneAccountAdapter from "../src/integrations/auth/phone-account";
import * as DeletionCase from "../src/services/deletion-case";
import * as PhoneAccount from "../src/services/phone-account";
import { withRealPostgresFixture } from "./real-postgres-fixture";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function, effecttsgo/strict-effect-provide -- Tests assert tagged outcomes through native PostgreSQL Promise boundaries. */

const adminActorId = AdminActorId.make("admin-native-postgres");
const reason = AdminReason.make("Native PostgreSQL concurrency test");

describe("Account authorities with native PostgreSQL", () => {
  it.effect("serializes concurrent opposing User Suspension transitions", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.gen(function* () {
        const userId = UserId.make("user-native-suspension");
        yield* seedVerifiedUser(database, userId, PhoneNumber.make("+14165550120"));
        const authorities = yield* makeAuthorities(database);
        yield* authorities.userSuspensions.suspend({ adminActorId, reason, userId });

        yield* Effect.all(
          [
            authorities.userSuspensions.restore({ adminActorId, reason, userId }),
            authorities.userSuspensions.suspend({ adminActorId, reason, userId }),
          ],
          { concurrency: "unbounded" },
        );
        const [fact, history] = yield* Effect.all([
          authorities.userSuspensions.inspect(userId),
          authorities.userSuspensions.history(userId),
        ]);
        const actions = history.map((event) => event.action);
        const latest = history.at(-1);

        expect([
          ["suspended", "restored"],
          ["suspended", "restored", "suspended"],
        ]).toContainEqual(actions);
        expect(latest).toBeDefined();
        expect(fact._tag).toBe(latest?.action === "suspended" ? "SuspendedUser" : "ActiveUser");
        for (const [index, event] of history.entries()) {
          const previous = history[index - 1];
          if (previous !== undefined) {
            expect(event.action).not.toBe(previous.action);
            expect(event.occurredAt.getTime()).toBeGreaterThan(previous.occurredAt.getTime());
          }
        }
      }),
    ),
  );

  it.effect("returns one replacement and one manual-support collision concurrently", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.gen(function* () {
        const firstUserId = UserId.make("user-native-phone-first");
        const secondUserId = UserId.make("user-native-phone-second");
        const replacement = PhoneNumber.make("+14165550129");
        yield* Effect.all([
          seedVerifiedUser(database, firstUserId, PhoneNumber.make("+14165550121")),
          seedVerifiedUser(database, secondUserId, PhoneNumber.make("+14165550122")),
        ]);
        const authorities = yield* makeAuthorities(database);
        const phoneAccounts = yield* makePhoneAccounts(database, authorities.deletionCases);

        const results = yield* Effect.all(
          [
            phoneAccounts.completeReplacement({
              code: Redacted.make("123456"),
              phoneNumber: replacement,
              userId: firstUserId,
            }),
            phoneAccounts.completeReplacement({
              code: Redacted.make("123456"),
              phoneNumber: replacement,
              userId: secondUserId,
            }),
          ],
          { concurrency: "unbounded" },
        );
        const rows = yield* Effect.promise(() =>
          database.select({ id: users.id, phoneNumber: users.phoneNumber }).from(users),
        );

        // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 has no toSorted, and this new local array is safe to mutate.
        expect(results.map((result) => result._tag).sort()).toEqual([
          "ManualSupportRequired",
          "PhoneAccountReplaced",
        ]);
        expect(rows.filter((row) => row.phoneNumber === replacement)).toHaveLength(1);
      }),
    ),
  );
});

const makeAuthorities = (database: Database) =>
  Effect.scoped(
    AccountAuthorities.make.pipe(
      Effect.provide(Layer.mergeAll(BrowserCrypto.layer, Db.layerFromDatabase(database))),
    ),
  );

const makePhoneAccounts = (database: Database, deletionCases: DeletionCase.Interface) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* PhoneAccountAdapter.make.pipe(
        Effect.provide(Db.layerFromDatabase(database)),
      );
      return yield* PhoneAccount.make.pipe(
        Effect.provideService(PhoneAccount.Store, store),
        Effect.provideService(
          PhoneAccount.Verification,
          PhoneAccount.Verification.of({
            sendCode: () => Effect.void,
            verifyCode: () => Effect.succeed(true),
          }),
        ),
        Effect.provideService(DeletionCase.Service, deletionCases),
      );
    }),
  );

const seedVerifiedUser = (database: Database, userId: UserId, phoneNumber: PhoneNumber) =>
  Effect.promise(() =>
    database.insert(users).values({
      email: `${userId}@example.test`,
      id: userId,
      name: "Native PostgreSQL User",
      phoneNumber,
      phoneNumberVerified: true,
    }),
  );
