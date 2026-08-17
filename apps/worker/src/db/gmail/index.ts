import type { Database } from "@osfo/db";
import { accounts } from "@osfo/db/schema/auth";
import { gmailConnections, gmailSendAttempts } from "@osfo/db/schema/gmail";
import { and, eq, lte } from "drizzle-orm";
import { DateTime, Effect, Predicate, Redacted, Schema } from "effect";

import { UserId } from "../../domain";
import type { ActionId } from "../../domain/action-execution";
import {
  GmailConnection,
  GmailConnectionId,
  GmailConnectionConflict,
  type GmailConnectionGrant,
  GmailPersistenceUnavailable,
  GmailProviderUnavailable,
  GmailSendAttempt,
  GmailSendRecoveryUnavailable,
} from "../../domain/gmail";
import type { ConnectionPersistence, SendAttemptPersistence } from "../../services/gmail";
import type { CredentialResolver } from "../../integrations/gmail/api";

const GmailConnectionRow = Schema.Struct({
  connectionId: GmailConnectionId,
  credentialReference: Schema.String,
  grantedAt: Schema.Date,
  providerAccountId: Schema.String,
  revokedAt: Schema.NullOr(Schema.Date),
  userId: UserId,
});
type GmailConnectionRow = typeof gmailConnections.$inferSelect;
type GmailSendAttemptRow = typeof gmailSendAttempts.$inferSelect;

/** PostgreSQL Gmail connection authority and provider recovery persistence. */
export interface Interface {
  readonly attempts: SendAttemptPersistence;
  readonly connections: ConnectionPersistence;
  readonly credentials: CredentialResolver;
}

/** Construct the focused Gmail PostgreSQL adapter. */
export const make = (
  database: Database,
  refreshAccessToken?: CredentialResolver["resolveAccessToken"],
): Interface => ({
  attempts: makeAttempts(database),
  connections: makeConnections(database),
  credentials: makeCredentials(database, refreshAccessToken),
});

const makeCredentials = (
  database: Database,
  refreshAccessToken?: CredentialResolver["resolveAccessToken"],
): CredentialResolver => ({
  resolveAccessToken: (connection, operation) =>
    Effect.gen(function* () {
      const now = DateTime.toDateUtc(yield* DateTime.now);
      const [stored] = yield* Effect.tryPromise({
        try: () =>
          database
            .select({
              accessToken: accounts.accessToken,
              accessTokenExpiresAt: accounts.accessTokenExpiresAt,
            })
            .from(accounts)
            .where(
              and(
                eq(accounts.id, connection.credentialReference),
                eq(accounts.userId, connection.userId),
                eq(accounts.accountId, connection.providerAccountId),
                eq(accounts.providerId, "google"),
              ),
            )
            .limit(1)
            .execute(),
        catch: (cause) => providerUnavailable(operation, cause),
      });
      if (
        stored?.accessToken !== undefined &&
        stored.accessToken !== null &&
        stored.accessTokenExpiresAt !== null &&
        stored.accessTokenExpiresAt > now
      ) {
        return Redacted.make(stored.accessToken);
      }
      if (stored === undefined) {
        return yield* providerUnavailable(operation, "gmail-credential-ownership-mismatch");
      }
      return yield* refreshAccessToken === undefined
        ? Effect.fail(providerUnavailable(operation, "missing-or-expired-google-access-token"))
        : refreshAccessToken(connection, operation);
    }),
});

const makeConnections = (database: Database): ConnectionPersistence => ({
  completeOAuth: (userId, now) =>
    Effect.gen(function* () {
      const linked = yield* connectionQuery("connect", () =>
        database
          .select({
            accountId: accounts.accountId,
            credentialReference: accounts.id,
            scope: accounts.scope,
          })
          .from(accounts)
          .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "google")))
          .limit(2)
          .execute(),
      );
      const account = linked[0];
      if (account === undefined || linked.length !== 1 || !hasRequiredGmailScopes(account.scope)) {
        return yield* new GmailConnectionConflict({
          connectionId: GmailConnectionId.make(`gmail:${userId}`),
          message: "Exactly one owned Google account with Gmail read and send scopes is required",
          userId,
        });
      }
      return yield* connectConnection(database, userId, {
        connectionId: GmailConnectionId.make(`gmail:${account.credentialReference}`),
        credentialReference: account.credentialReference,
        grantedAt: now,
        providerAccountId: account.accountId,
      });
    }),
  findById: (connectionId) => readConnectionById(database, connectionId),
  findByUser: (userId) => readConnectionByUser(database, userId),
  revoke: (connection, revokedAt) =>
    Effect.gen(function* () {
      yield* connectionQuery("revoke", () =>
        database
          .update(gmailConnections)
          .set({ revokedAt })
          .where(
            and(
              eq(gmailConnections.connectionId, connection.connectionId),
              eq(gmailConnections.userId, connection.userId),
            ),
          )
          .execute(),
      );
      const stored = yield* requireConnectionById(database, connection.connectionId);
      if (Predicate.isTagged(stored, "Connected")) {
        return yield* new GmailPersistenceUnavailable({
          cause: stored,
          message: "Gmail connection revocation was not stored",
          operation: "revoke",
        });
      }
      return stored;
    }),
});

const connectConnection = (database: Database, userId: UserId, grant: GmailConnectionGrant) =>
  Effect.gen(function* () {
    const [credential] = yield* connectionQuery("connect", () =>
      database
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.id, grant.credentialReference),
            eq(accounts.userId, userId),
            eq(accounts.accountId, grant.providerAccountId),
            eq(accounts.providerId, "google"),
          ),
        )
        .limit(1)
        .execute(),
    );
    if (credential === undefined) {
      return yield* new GmailConnectionConflict({
        connectionId: grant.connectionId,
        message: "The Gmail OAuth credential does not belong to this User and provider account",
        userId,
      });
    }
    const existing = yield* readConnectionByUser(database, userId);
    if (existing !== null) {
      if (
        existing.connectionId !== grant.connectionId ||
        existing.providerAccountId !== grant.providerAccountId
      ) {
        return yield* new GmailConnectionConflict({
          connectionId: grant.connectionId,
          message: "The User already owns a different Gmail Integration Connection",
          userId,
        });
      }
      if (Predicate.isTagged(existing, "Connected")) return existing;
      yield* connectionQuery("connect", () =>
        database
          .update(gmailConnections)
          .set({
            credentialReference: grant.credentialReference,
            grantedAt: grant.grantedAt,
            revokedAt: null,
          })
          .where(eq(gmailConnections.connectionId, grant.connectionId))
          .execute(),
      );
      return yield* requireConnectedById(database, grant.connectionId);
    }
    const providerOwner = yield* connectionQuery("connect", () =>
      database
        .select({ userId: gmailConnections.userId })
        .from(gmailConnections)
        .where(eq(gmailConnections.providerAccountId, grant.providerAccountId))
        .limit(1)
        .execute(),
    );
    if (providerOwner[0] !== undefined) {
      return yield* new GmailConnectionConflict({
        connectionId: grant.connectionId,
        message: "The Gmail provider account already belongs to another User",
        userId,
      });
    }
    yield* connectionQuery("connect", () =>
      database
        .insert(gmailConnections)
        .values({ ...grant, revokedAt: null, userId })
        .execute(),
    );
    return yield* requireConnectedById(database, grant.connectionId);
  });

const requiredGmailScopes = new Set([
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
]);

const hasRequiredGmailScopes = (scope: string | null) => {
  const granted = new Set(scope?.split(/[\s,]+/u) ?? []);
  return [...requiredGmailScopes].every((required) => granted.has(required));
};

const makeAttempts = (database: Database): SendAttemptPersistence => ({
  begin: (actionId, connectionId, now) =>
    Effect.gen(function* () {
      const inserted = yield* attemptQuery(actionId, "begin", () =>
        database
          .insert(gmailSendAttempts)
          .values({ actionId, connectionId, outcome: "pending", startedAt: now })
          .onConflictDoNothing({ target: gmailSendAttempts.actionId })
          .returning()
          .execute(),
      );
      const row = inserted[0] ?? (yield* readAttempt(database, actionId));
      const attempt = yield* decodeAttempt(actionId, row);
      if (attempt.connectionId !== connectionId) {
        return yield* new GmailSendRecoveryUnavailable({
          actionId,
          cause: attempt,
          message: "The Gmail Action identity has conflicting provider recovery facts",
          operation: "begin",
        });
      }
      if (inserted[0] !== undefined) return { _tag: "AttemptStarted", attempt } as const;
      if (attempt.outcome !== "pending") return { _tag: "ExistingAttempt", attempt } as const;
      const recoveryCutoff = DateTime.toDateUtc(
        DateTime.subtract(DateTime.fromDateUnsafe(now), { minutes: sendRecoveryLeaseMinutes }),
      );
      const claimed = yield* attemptQuery(actionId, "begin", () =>
        database
          .update(gmailSendAttempts)
          .set({ startedAt: now })
          .where(
            and(
              eq(gmailSendAttempts.actionId, actionId),
              eq(gmailSendAttempts.connectionId, connectionId),
              eq(gmailSendAttempts.outcome, "pending"),
              lte(gmailSendAttempts.startedAt, recoveryCutoff),
            ),
          )
          .returning()
          .execute(),
      );
      const claimedAttempt = claimed[0];
      return claimedAttempt === undefined
        ? { _tag: "ActiveAttempt", attempt }
        : {
            _tag: "RecoveryStarted",
            attempt: yield* decodeAttempt(actionId, claimedAttempt),
          };
    }),
  complete: (actionId, outcome) =>
    Effect.gen(function* () {
      const current = yield* decodeAttempt(actionId, yield* readAttempt(database, actionId));
      if (current.outcome === outcome) return undefined;
      if (current.outcome !== "pending" || outcome === "pending") {
        return yield* new GmailSendRecoveryUnavailable({
          actionId,
          cause: current,
          message: "Gmail provider recovery evidence cannot change terminal outcome",
          operation: "complete",
        });
      }
      const updated = yield* attemptQuery(actionId, "complete", () =>
        database
          .update(gmailSendAttempts)
          .set({ outcome })
          .where(
            and(eq(gmailSendAttempts.actionId, actionId), eq(gmailSendAttempts.outcome, "pending")),
          )
          .returning()
          .execute(),
      );
      if (updated[0] !== undefined) return undefined;
      const winner = yield* decodeAttempt(actionId, yield* readAttempt(database, actionId));
      if (winner.outcome === outcome) return undefined;
      return yield* new GmailSendRecoveryUnavailable({
        actionId,
        cause: winner,
        message: "Another Gmail recovery transition stored a conflicting outcome",
        operation: "complete",
      });
    }),
});

const sendRecoveryLeaseMinutes = 5;

const readConnectionById = (database: Database, connectionId: GmailConnectionId) =>
  connectionQuery("findById", () =>
    database
      .select()
      .from(gmailConnections)
      .where(eq(gmailConnections.connectionId, connectionId))
      .limit(1)
      .execute(),
  ).pipe(Effect.flatMap((rows) => decodeConnection(rows[0])));

const readConnectionByUser = (database: Database, userId: UserId) =>
  connectionQuery("findByUser", () =>
    database
      .select()
      .from(gmailConnections)
      .where(eq(gmailConnections.userId, userId))
      .limit(1)
      .execute(),
  ).pipe(Effect.flatMap((rows) => decodeConnection(rows[0])));

const requireConnectionById = (database: Database, connectionId: GmailConnectionId) =>
  readConnectionById(database, connectionId).pipe(
    Effect.flatMap((connection) =>
      connection === null
        ? Effect.fail(
            new GmailPersistenceUnavailable({
              cause: connectionId,
              message: "The stored Gmail connection could not be read",
              operation: "findById",
            }),
          )
        : Effect.succeed(connection),
    ),
  );

const requireConnectedById = (database: Database, connectionId: GmailConnectionId) =>
  requireConnectionById(database, connectionId).pipe(
    Effect.flatMap((connection) =>
      Predicate.isTagged(connection, "Connected")
        ? Effect.succeed(connection)
        : Effect.fail(
            new GmailPersistenceUnavailable({
              cause: connection,
              message: "The Gmail connection remained revoked after OAuth grant storage",
              operation: "connect",
            }),
          ),
    ),
  );

const decodeConnection = (row: GmailConnectionRow | undefined) => {
  if (row === undefined) return Effect.succeed(null);
  return Schema.decodeEffect(GmailConnectionRow)(row).pipe(
    Effect.mapError(
      (cause) =>
        new GmailPersistenceUnavailable({
          cause,
          message: "PostgreSQL returned invalid Gmail connection facts",
          operation: "findById",
        }),
    ),
    Effect.map((stored) =>
      stored.revokedAt === null
        ? GmailConnection.make({ ...stored, _tag: "Connected" })
        : GmailConnection.make({ ...stored, _tag: "Revoked", revokedAt: stored.revokedAt }),
    ),
  );
};

const readAttempt = (database: Database, actionId: ActionId) =>
  attemptQuery(actionId, "begin", () =>
    database
      .select()
      .from(gmailSendAttempts)
      .where(eq(gmailSendAttempts.actionId, actionId))
      .limit(1)
      .execute(),
  ).pipe(Effect.map((rows) => rows[0]));

const decodeAttempt = (actionId: ActionId, row: GmailSendAttemptRow | undefined) =>
  Schema.decodeUnknownEffect(GmailSendAttempt)(row).pipe(
    Effect.mapError(
      (cause) =>
        new GmailSendRecoveryUnavailable({
          actionId,
          cause,
          message: "PostgreSQL returned invalid Gmail send recovery evidence",
          operation: "begin",
        }),
    ),
  );

const connectionQuery = <A>(
  operation: GmailPersistenceUnavailable["operation"],
  query: () => Promise<A>,
) =>
  Effect.tryPromise({
    try: query,
    catch: (cause) =>
      new GmailPersistenceUnavailable({
        cause,
        message: "PostgreSQL could not access Gmail connection authority",
        operation,
      }),
  });

const attemptQuery = <A>(
  actionId: ActionId,
  operation: GmailSendRecoveryUnavailable["operation"],
  query: () => Promise<A>,
) =>
  Effect.tryPromise({
    try: query,
    catch: (cause) =>
      new GmailSendRecoveryUnavailable({
        actionId,
        cause,
        message: "PostgreSQL could not access Gmail provider recovery evidence",
        operation,
      }),
  });

const providerUnavailable = (operation: GmailProviderUnavailable["operation"], cause: unknown) =>
  new GmailProviderUnavailable({
    cause,
    message: "The current Gmail OAuth credential is unavailable",
    operation,
  });
