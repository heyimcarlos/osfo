import { BrowserCrypto } from "@effect/platform-browser";
import { describe, expect, it, layer } from "@effect/vitest";
import { agents } from "@osfo/db/schema/agents";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { sessions, users } from "@osfo/db/schema/auth";
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
import { AgentDirectory } from "../src/services/agent-directory";
import { Registration } from "../src/services/registration";

const fixture = Effect.runSync(makeTestDatabase);
await Effect.runPromise(applyMigrations(fixture.client));
let phoneSequence = 100;
const dbLayer = layerFromDatabase(fixture.database);
const agentRegistrationLayer = Layer.succeed(
  Registration.AgentRegistration,
  Registration.AgentRegistration.of({ initialize: () => Effect.void }),
);
const noChannelLinks = { resolve: () => Effect.succeed(null) };
const serviceLayer = Layer.merge(
  Registration.layerWithoutDependencies,
  AgentDirectory.layerWithoutDependencies,
).pipe(
  Layer.provideMerge(dbLayer),
  Layer.provide(BrowserCrypto.layer),
  Layer.provide(agentRegistrationLayer),
);

describe("PostgreSQL Layer lifetime", () => {
  // oxlint-disable-next-line effecttsgo/async-function -- ManagedRuntime exposes Promise boundaries for independent scopes and disposal.
  it("keeps one client open across query scopes and closes it with the runtime", async () => {
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

layer(serviceLayer)("Control-plane services", (test) => {
  test.effect("provisions a User and stable Agent route atomically", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* AgentDirectory.Service;
      const registration = yield* Registration.Service;
      const userId = UserId.make("user-001");
      yield* seedUser(userId);

      const completed = yield* completeRegistration(registration, userId);
      const route = yield* agentDirectory.resolve(userId);

      expect(completed).toMatchObject({ userId: "user-001" });
      expect(route).toEqual({
        agentId: completed.agentId,
        userId: "user-001",
      });
    }),
  );

  test.effect("returns one User when provisioning runs concurrently", () =>
    Effect.gen(function* () {
      const registration = yield* Registration.Service;
      const userId = UserId.make("user-concurrent");
      yield* seedUser(userId);

      const [first, concurrent] = yield* Effect.all(
        [completeRegistration(registration, userId), completeRegistration(registration, userId)],
        { concurrency: "unbounded" },
      );
      const repeated = yield* completeRegistration(registration, userId);

      expect(concurrent).toEqual(first);
      expect(repeated).toEqual(first);
    }),
  );

  test.effect("returns unavailable when the stored completion time conflicts", () =>
    Effect.gen(function* () {
      const db = yield* database;
      const registration = yield* Registration.Service;
      const userId = UserId.make("user-completion-conflict");
      yield* seedUser(userId);
      yield* completeRegistration(registration, userId);
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(users)
            .set({
              registrationCompletedAt: DateTime.toDateUtc(
                DateTime.makeUnsafe("2026-08-12T15:01:16.000Z"),
              ),
            })
            .where(eq(users.id, userId))
            .execute(),
        catch: (cause) => dbUnavailable("completeRegistration", cause),
      });

      const unavailable = yield* Effect.flip(completeRegistration(registration, userId));

      expect(unavailable).toMatchObject({
        _tag: "DbUnavailable",
        operation: "completeRegistration",
      });
    }),
  );

  test.effect("returns unavailable when completed provisioning facts are partial", () =>
    Effect.gen(function* () {
      const db = yield* database;
      const registration = yield* Registration.Service;
      const userId = UserId.make("user-partial-provisioning");
      yield* seedUser(userId);
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(users)
            .set({
              registrationCompletedAt: DateTime.toDateUtc(
                DateTime.makeUnsafe("2026-08-12T15:01:20.000Z"),
              ),
            })
            .where(eq(users.id, userId))
            .execute(),
        catch: (cause) => dbUnavailable("completeRegistration", cause),
      });

      const unavailable = yield* Effect.flip(completeRegistration(registration, userId));

      expect(unavailable).toMatchObject({
        _tag: "DbUnavailable",
        operation: "completeRegistration",
      });
    }),
  );

  test.effect("rolls back new provisioning facts when the Agent insert conflicts", () =>
    Effect.gen(function* () {
      const db = yield* database;
      const registration = yield* Registration.Service;
      const userId = UserId.make("user-agent-conflict");
      yield* seedUser(userId);
      yield* Effect.tryPromise({
        try: () =>
          db.insert(agents).values({
            agent_id: AgentId.make("agent-existing"),
            created_at: "2026-08-12T15:01:30.000Z",
            user_id: userId,
          }),
        catch: (cause) => dbUnavailable("completeRegistration", cause),
      });

      const failed = yield* Effect.flip(completeRegistration(registration, userId));
      const storedSubscriptions = yield* Effect.tryPromise({
        try: () =>
          db.select().from(billingSubscriptions).where(eq(billingSubscriptions.user_id, userId)),
        catch: (cause) => dbUnavailable("completeRegistration", cause),
      });
      const storedPeriods = yield* Effect.tryPromise({
        try: () => db.select().from(allowancePeriods).where(eq(allowancePeriods.user_id, userId)),
        catch: (cause) => dbUnavailable("completeRegistration", cause),
      });
      const [storedUser] = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              registrationCompletedAt: users.registrationCompletedAt,
            })
            .from(users)
            .where(eq(users.id, userId)),
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

  test.effect("loads current file authority and fails closed when persisted facts disappear", () =>
    Effect.gen(function* () {
      const db = yield* database;
      const registration = yield* Registration.Service;
      const userId = UserId.make("user-file-authority");
      yield* seedUser(userId);
      const registered = yield* completeRegistration(registration, userId);
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

      const current = yield* loadCurrentFileAuthorization(
        db,
        noChannelLinks,
        registered.agentId,
        context,
        now,
      );
      const suspended = yield* loadCurrentFileAuthorization(
        db,
        noChannelLinks,
        registered.agentId,
        {
          ...context,
          user: { _tag: "SuspendedUser", userId },
        },
        now,
      );
      const deletionRevoked = yield* loadCurrentFileAuthorization(
        db,
        noChannelLinks,
        registered.agentId,
        {
          ...context,
          deletionAccess: { _tag: "DeletionAccessRevoked" },
        },
        now,
      );
      yield* Effect.promise(() => db.delete(sessions).where(eq(sessions.id, "file-session")));
      const revoked = yield* loadCurrentFileAuthorization(
        db,
        noChannelLinks,
        registered.agentId,
        context,
        now,
      );
      const otherUserId = UserId.make("user-file-authority-other");
      yield* seedUser(otherUserId);
      const otherAgent = yield* completeRegistration(registration, otherUserId);
      const wrongAgent = yield* loadCurrentFileAuthorization(
        db,
        noChannelLinks,
        otherAgent.agentId,
        context,
        now,
      );
      yield* Effect.promise(() =>
        db.delete(billingSubscriptions).where(eq(billingSubscriptions.user_id, userId)),
      );
      const missingSubscription = yield* Effect.flip(
        loadCurrentFileAuthorization(db, noChannelLinks, registered.agentId, context, now),
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
    phoneSequence += 1;
    yield* Effect.tryPromise({
      try: () =>
        db.insert(users).values({
          email: `${userId}@invalid.example`,
          id: userId,
          name: "Test User",
          phoneNumber: `+1416555${phoneSequence.toString().padStart(4, "0")}`,
          phoneNumberVerified: true,
        }),
      catch: (cause) => dbUnavailable("completeRegistration", cause),
    });
  });

const completeRegistration = (registration: Registration.Interface, userId: UserId) =>
  registration.complete({
    profile: { helpAreas: [], locale: "en", preferredName: "Test User" },
    userId,
  });
