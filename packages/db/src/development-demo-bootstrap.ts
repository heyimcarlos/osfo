import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  DevelopmentBootstrapRateLimited,
  DevelopmentBootstrapRejected,
  DevelopmentBootstrapUnavailable,
  DevelopmentDemoBootstrap,
  DevelopmentDemoSession,
  type DevelopmentDemoSessionRequest,
} from "@osfo/api";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  admissionGlobalCapacity,
  admissionPrincipalCapacity,
  authenticationSessions,
  principals,
  threads,
} from "./schema.js";
const defaultMaxAttempts = 5;
const defaultWindowMilliseconds = 60_000;
const sessionLifetimeMilliseconds = 8 * 60 * 60 * 1_000;
const accessCodeDigestPattern = /^[0-9a-f]{64}$/u;

export interface DevelopmentDemoBootstrapDatabaseConfig {
  readonly accessCodeSha256: string;
  readonly databaseUrl: string;
  readonly makeRandomBytes?: (size: number) => Uint8Array;
  readonly makeUuid?: () => string;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
  readonly windowMilliseconds?: number;
}

export interface CreateDevelopmentDemoAuthorityOptions {
  readonly databaseUrl: string;
  readonly makeRandomBytes?: (size: number) => Uint8Array;
  readonly makeUuid?: () => string;
  readonly now?: Date;
}

export interface DevelopmentDemoAuthority {
  readonly authenticationToken: string;
  readonly expiresAt: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly threadId: string;
}

export class DevelopmentDemoAuthorityUnavailable extends Data.TaggedError(
  "DevelopmentDemoAuthorityUnavailable",
)<{}> {}

interface AttemptRateLimiter {
  readonly consume: (nowMilliseconds: number) => number | undefined;
}

const makeAttemptRateLimiter = (
  maxAttempts: number,
  windowMilliseconds: number,
): AttemptRateLimiter => {
  const attempts: Array<number> = [];

  return {
    consume: (nowMilliseconds) => {
      while (attempts[0] !== undefined && attempts[0] <= nowMilliseconds - windowMilliseconds) {
        attempts.shift();
      }
      const oldestAttempt = attempts[0];
      if (attempts.length >= maxAttempts && oldestAttempt !== undefined) {
        return Math.max(
          1,
          Math.min(60, Math.ceil((oldestAttempt + windowMilliseconds - nowMilliseconds) / 1_000)),
        );
      }
      attempts.push(nowMilliseconds);
      return undefined;
    },
  };
};

const accessCodeMatches = (accessCode: string, expectedSha256: string) => {
  if (!accessCodeDigestPattern.test(expectedSha256)) return false;
  const received = createHash("sha256").update(accessCode).digest();
  const expected = Buffer.from(expectedSha256, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
};

export const createDevelopmentDemoAuthority = (
  options: CreateDevelopmentDemoAuthorityOptions,
): Effect.Effect<DevelopmentDemoAuthority, DevelopmentDemoAuthorityUnavailable> =>
  Effect.gen(function* () {
    const generated = yield* Effect.try({
      try: () => {
        const makeUuid = options.makeUuid ?? randomUUID;
        const now = options.now ?? new Date();
        const authenticationToken = Buffer.from(
          (options.makeRandomBytes ?? randomBytes)(32),
        ).toString("base64url");
        const principalId = makeUuid();
        const credential = {
          authenticationToken,
          expiresAt: new Date(now.getTime() + sessionLifetimeMilliseconds).toISOString(),
          sessionId: makeUuid(),
          threadId: makeUuid(),
        };
        return { credential, principalId };
      },
      catch: () => new DevelopmentDemoAuthorityUnavailable(),
    });
    const db = yield* PgDrizzle.makeWithDefaults();
    const tokenSha256 = createHash("sha256")
      .update(generated.credential.authenticationToken)
      .digest("hex");

    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.insert(principals).values({ principalId: generated.principalId });
        yield* tx.insert(authenticationSessions).values({
          expiresAt: generated.credential.expiresAt,
          principalId: generated.principalId,
          sessionId: generated.credential.sessionId,
          tokenSha256,
        });
        yield* tx.insert(threads).values({
          principalId: generated.principalId,
          threadId: generated.credential.threadId,
        });
        yield* tx.insert(admissionPrincipalCapacity).values({
          principalId: generated.principalId,
          reservedCount: 0,
        });
        yield* tx
          .insert(admissionGlobalCapacity)
          .values({ singleton: true, reservedCount: 0 })
          .onConflictDoNothing();
      }),
    );

    return { ...generated.credential, principalId: generated.principalId };
  }).pipe(
    Effect.provide(
      PgClient.layer({
        applicationName: "osfo-development-demo-bootstrap",
        maxConnections: 4,
        url: Redacted.make(options.databaseUrl),
      }),
    ),
    Effect.mapError(() => new DevelopmentDemoAuthorityUnavailable()),
  );

export const makeDevelopmentDemoBootstrapLayer = (
  config: DevelopmentDemoBootstrapDatabaseConfig,
) => {
  const maxAttempts = Math.min(
    1_000,
    Math.max(1, Math.floor(config.maxAttempts ?? defaultMaxAttempts)),
  );
  const windowMilliseconds = Math.min(
    60_000,
    Math.max(1_000, Math.floor(config.windowMilliseconds ?? defaultWindowMilliseconds)),
  );
  const now = config.now ?? (() => new Date());
  const makeRandomBytes = config.makeRandomBytes ?? randomBytes;
  const makeUuid = config.makeUuid ?? randomUUID;
  const rateLimiter = makeAttemptRateLimiter(maxAttempts, windowMilliseconds);
  return Layer.succeed(
    DevelopmentDemoBootstrap,
    DevelopmentDemoBootstrap.of({
      create: Effect.fn("DatabaseDevelopmentDemoBootstrap.create")(function* (
        request: DevelopmentDemoSessionRequest,
      ) {
        const requestedAt = now();
        const retryAfterSeconds = rateLimiter.consume(requestedAt.getTime());
        if (retryAfterSeconds !== undefined) {
          return yield* new DevelopmentBootstrapRateLimited({ retryAfterSeconds });
        }
        if (!accessCodeMatches(request.accessCode, config.accessCodeSha256)) {
          return yield* new DevelopmentBootstrapRejected();
        }

        const generated = yield* createDevelopmentDemoAuthority({
          databaseUrl: config.databaseUrl,
          makeRandomBytes,
          makeUuid,
          now: requestedAt,
        }).pipe(Effect.mapError(() => new DevelopmentBootstrapUnavailable()));

        return new DevelopmentDemoSession({
          authenticationToken: generated.authenticationToken,
          expiresAt: generated.expiresAt,
          productionQualification: "MISSING",
          protocolVersion: 1,
          scope: "development",
          threadId: generated.threadId,
        });
      }),
    }),
  );
};
