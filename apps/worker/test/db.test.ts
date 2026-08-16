import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { expect, layer } from "@effect/vitest";
import { agents } from "@osfo/db/schema/agents";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users as usersTable } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { applyMigrations, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";

import { database, dbUnavailable, layerFromDatabase } from "../src/db";
import { AgentId, UserId } from "../src/domain";
import * as AgentDirectory from "../src/services/agent-directory";
import * as Registration from "../src/services/registration";

const fixture = Effect.runSync(makeTestDatabase);
await Effect.runPromise(applyMigrations(fixture.client));
const dbLayer = layerFromDatabase(fixture.database);
const serviceLayer = Layer.merge(
  Registration.layerWithoutDependencies,
  AgentDirectory.layerWithoutDependencies,
).pipe(Layer.provideMerge(dbLayer), Layer.provide(BrowserCrypto.layer));

layer(serviceLayer)("Control-plane services", (it) => {
  it.effect("provisions a User and stable Agent route atomically", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* AgentDirectory.Service;
      const registration = yield* Registration.Service;
      const userId = UserId.make("user-001");
      yield* seedUser(userId);

      const completed = yield* registration.complete(userId);
      const route = yield* agentDirectory.resolve(userId);

      expect(completed).toMatchObject({ userId: "user-001" });
      expect(route).toEqual({
        agentId: completed.agentId,
        userId: "user-001",
      });
    }),
  );

  it.effect("returns one User when provisioning runs concurrently", () =>
    Effect.gen(function* () {
      const registration = yield* Registration.Service;
      const userId = UserId.make("user-concurrent");
      yield* seedUser(userId);

      const [first, concurrent] = yield* Effect.all(
        [registration.complete(userId), registration.complete(userId)],
        { concurrency: "unbounded" },
      );
      const repeated = yield* registration.complete(userId);

      expect(concurrent).toEqual(first);
      expect(repeated).toEqual(first);
    }),
  );

  it.effect("returns unavailable when the stored completion time conflicts", () =>
    Effect.gen(function* () {
      const db = yield* database;
      const registration = yield* Registration.Service;
      const userId = UserId.make("user-completion-conflict");
      yield* seedUser(userId);
      yield* registration.complete(userId);
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(usersTable)
            .set({
              registrationCompletedAt: DateTime.toDateUtc(
                DateTime.makeUnsafe("2026-08-12T15:01:16.000Z"),
              ),
            })
            .where(eq(usersTable.id, userId))
            .execute(),
        catch: (cause) => dbUnavailable("completeRegistration", cause),
      });

      const unavailable = yield* Effect.flip(registration.complete(userId));

      expect(unavailable).toMatchObject({
        _tag: "DbUnavailable",
        operation: "completeRegistration",
      });
    }),
  );

  it.effect("returns unavailable when completed provisioning facts are partial", () =>
    Effect.gen(function* () {
      const db = yield* database;
      const registration = yield* Registration.Service;
      const userId = UserId.make("user-partial-provisioning");
      yield* seedUser(userId);
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(usersTable)
            .set({
              registrationCompletedAt: DateTime.toDateUtc(
                DateTime.makeUnsafe("2026-08-12T15:01:20.000Z"),
              ),
            })
            .where(eq(usersTable.id, userId))
            .execute(),
        catch: (cause) => dbUnavailable("completeRegistration", cause),
      });

      const unavailable = yield* Effect.flip(registration.complete(userId));

      expect(unavailable).toMatchObject({
        _tag: "DbUnavailable",
        operation: "completeRegistration",
      });
    }),
  );

  it.effect("rolls back new provisioning facts when the Agent insert conflicts", () =>
    Effect.gen(function* () {
      const db = yield* database;
      const registration = yield* Registration.Service;
      const userId = UserId.make("user-agent-conflict");
      yield* seedUser(userId);
      yield* Effect.tryPromise({
        try: () =>
          db.insert(agents).values({
            agentId: AgentId.make("agent-existing"),
            createdAt: "2026-08-12T15:01:30.000Z",
            userId,
          }),
        catch: (cause) => dbUnavailable("completeRegistration", cause),
      });

      const failed = yield* Effect.flip(registration.complete(userId));
      const storedSubscriptions = yield* Effect.tryPromise({
        try: () =>
          db.select().from(billingSubscriptions).where(eq(billingSubscriptions.userId, userId)),
        catch: (cause) => dbUnavailable("completeRegistration", cause),
      });
      const storedPeriods = yield* Effect.tryPromise({
        try: () => db.select().from(allowancePeriods).where(eq(allowancePeriods.userId, userId)),
        catch: (cause) => dbUnavailable("completeRegistration", cause),
      });
      const [storedUser] = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              registrationCompletedAt: usersTable.registrationCompletedAt,
            })
            .from(usersTable)
            .where(eq(usersTable.id, userId)),
        catch: (cause) => dbUnavailable("completeRegistration", cause),
      });

      expect(failed).toMatchObject({
        _tag: "DbWriteRejected",
        operation: "completeRegistration",
      });
      expect(storedSubscriptions).toEqual([]);
      expect(storedPeriods).toEqual([]);
      expect(storedUser?.registrationCompletedAt).toBeNull();
    }),
  );
});

const seedUser = (userId: UserId) =>
  Effect.gen(function* () {
    const db = yield* database;
    yield* Effect.tryPromise({
      try: () =>
        db.insert(usersTable).values({
          email: `${userId}@invalid.example`,
          id: userId,
          name: "Test User",
        }),
      catch: (cause) => dbUnavailable("completeRegistration", cause),
    });
  });
