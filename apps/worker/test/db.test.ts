import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { describe, expect, it as effectIt, layer } from "@effect/vitest";
import { agents } from "@osfo/db/schema/agents";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { sessions, users as usersTable } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { applyMigrations, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer, ManagedRuntime } from "effect";
import postgres from "postgres";

import { database, dbUnavailable, layerFromClientAcquisition, layerFromDatabase } from "../src/db";
import { AgentId, PlanPolicyVersion, UserId } from "../src/domain";
import { AuthSessionId } from "../src/domain/auth-session";
import { loadCurrentFileAuthorization } from "../src/integrations/postgres/file-authorization";
import { AuthorizationContext } from "../src/services/authorization";
import * as AgentDirectory from "../src/services/agent-directory";
import * as Registration from "../src/services/registration";

const fixture = Effect.runSync(makeTestDatabase);
await Effect.runPromise(applyMigrations(fixture.client));
const dbLayer = layerFromDatabase(fixture.database);
const serviceLayer = Layer.merge(
  Registration.layerWithoutDependencies,
  AgentDirectory.layerWithoutDependencies,
).pipe(Layer.provideMerge(dbLayer), Layer.provide(BrowserCrypto.layer));

describe("PostgreSQL Layer lifetime", () => {
  // oxlint-disable-next-line effecttsgo/async-function -- ManagedRuntime exposes Promise boundaries for independent scopes and disposal.
  effectIt("keeps one client open across query scopes and closes it with the runtime", async () => {
    let endCalls = 0;
    const client = postgres("postgres://test:test@localhost/test", { max: 1 });
    client.end = () => {
      endCalls += 1;
      return Promise.resolve();
    };
    const runtime = ManagedRuntime.make(
      layerFromClientAcquisition(
        Effect.acquireRelease(Effect.succeed(client), (acquired) =>
          Effect.promise(() => acquired.end()),
        ),
      ),
    );

    const first = await runtime.runPromise(Effect.scoped(database));
    const second = await runtime.runPromise(Effect.scoped(database));

    expect(second).toBe(first);
    expect(endCalls).toBe(0);

    await runtime.dispose();
    expect(endCalls).toBe(1);
  });
});

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

  it.effect("loads current file authority and fails closed when persisted facts disappear", () =>
    Effect.gen(function* () {
      const db = yield* database;
      const registration = yield* Registration.Service;
      const userId = UserId.make("user-file-authority");
      yield* seedUser(userId);
      const registered = yield* registration.complete(userId);
      const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z"));
      yield* Effect.promise(() =>
        db.insert(sessions).values({
          expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-01T00:00:00.000Z")),
          id: "file-session",
          token: "file-session-token",
          userId,
        }),
      );
      const context = AuthorizationContext.make({
        allowance: { _tag: "Unavailable" },
        approval: null,
        authority: {
          _tag: "AuthSession",
          authSessionId: AuthSessionId.make("file-session"),
          expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-01T00:00:00.000Z")),
          userId,
        },
        deletionAccess: { _tag: "DeletionAccessAvailable" },
        gmailConnection: null,
        liveFacts: {
          activeGmSummonsInSession: 0n,
          activeReminders: 0n,
          concurrentWorkflows: 0n,
          retainedFileBytes: 0n,
        },
        now,
        originatingAuthority: {
          _tag: "AuthSession",
          authSessionId: AuthSessionId.make("file-session"),
        },
        requestVendorUsdMicros: 0n,
        resourceOwnerUserId: userId,
        subscription: { plan: "free", planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
        user: { _tag: "ActiveUser", userId },
      });

      const current = yield* loadCurrentFileAuthorization(db, registered.agentId, context, now);
      const suspended = yield* loadCurrentFileAuthorization(
        db,
        registered.agentId,
        {
          ...context,
          user: { _tag: "SuspendedUser", userId },
        },
        now,
      );
      const deletionRevoked = yield* loadCurrentFileAuthorization(
        db,
        registered.agentId,
        {
          ...context,
          deletionAccess: { _tag: "DeletionAccessRevoked" },
        },
        now,
      );
      yield* Effect.promise(() => db.delete(sessions).where(eq(sessions.id, "file-session")));
      const revoked = yield* loadCurrentFileAuthorization(db, registered.agentId, context, now);
      const otherUserId = UserId.make("user-file-authority-other");
      yield* seedUser(otherUserId);
      const otherAgent = yield* registration.complete(otherUserId);
      const wrongAgent = yield* loadCurrentFileAuthorization(db, otherAgent.agentId, context, now);
      yield* Effect.promise(() =>
        db.delete(billingSubscriptions).where(eq(billingSubscriptions.userId, userId)),
      );
      const missingSubscription = yield* Effect.flip(
        loadCurrentFileAuthorization(db, registered.agentId, context, now),
      );

      expect(current.authority).toMatchObject({ _tag: "AuthSession" });
      expect(suspended.user).toMatchObject({ _tag: "SuspendedUser" });
      expect(deletionRevoked.deletionAccess).toMatchObject({ _tag: "DeletionAccessRevoked" });
      expect(revoked.authority).toMatchObject({ _tag: "RevokedAuthSession" });
      expect(wrongAgent.authority).toBeNull();
      expect(missingSubscription).toMatchObject({ _tag: "CurrentFileAuthorizationUnavailable" });
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
