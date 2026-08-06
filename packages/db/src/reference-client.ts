import { createHash, randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  admissionGlobalCapacity,
  admissionPrincipalCapacity,
  authenticationSessions,
  principals,
  threads,
} from "./schema.js";

export const referenceClientPrincipalId = "b3ef0861-2df7-4d2a-a195-fbc5ed75bc81";

export interface ReferenceClientAuthority {
  readonly authenticationToken: string;
  readonly databaseUrl: string;
  readonly threadId: string;
}

export const seedReferenceClientAuthority = (options: ReferenceClientAuthority) =>
  Effect.gen(function* () {
    const db = yield* PgDrizzle.makeWithDefaults();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
    const tokenSha256 = createHash("sha256").update(options.authenticationToken).digest("hex");

    yield* db
      .insert(principals)
      .values({ principalId: referenceClientPrincipalId })
      .onConflictDoNothing();
    yield* db
      .insert(authenticationSessions)
      .values({
        expiresAt,
        principalId: referenceClientPrincipalId,
        sessionId: randomUUID(),
        tokenSha256,
      })
      .onConflictDoUpdate({
        target: authenticationSessions.tokenSha256,
        set: { expiresAt, principalId: referenceClientPrincipalId, revokedAt: null },
      });
    yield* db
      .insert(threads)
      .values({ principalId: referenceClientPrincipalId, threadId: options.threadId })
      .onConflictDoNothing();
    yield* db
      .insert(admissionPrincipalCapacity)
      .values({ principalId: referenceClientPrincipalId, reservedCount: 0 })
      .onConflictDoNothing();
    yield* db
      .insert(admissionGlobalCapacity)
      .values({ singleton: true, reservedCount: 0 })
      .onConflictDoNothing();

    return {
      principalId: referenceClientPrincipalId,
      threadId: options.threadId,
    };
  }).pipe(
    Effect.provide(
      PgClient.layer({
        applicationName: "osfo-reference-client-seed",
        url: Redacted.make(options.databaseUrl),
      }),
    ),
  );
