import { Effect, Schema } from "effect";

import initialMigrationSql from "./migrations/0000_bored_union_jack.sql";
import {
  AgentMigrationDefinitionMismatch,
  AgentMigrationDigestMismatch,
  type AgentMigrationError,
  AgentMigrationFailed,
  AgentMigrationHistoryUnsupported,
} from "./errors";

/** One immutable generated Agent SQLite migration and its verified digest. */
export interface AgentMigration {
  readonly digest: string;
  readonly sql: string;
  readonly version: number;
}

/** Complete immutable Osfo-owned Agent SQLite migration history. */
export const agentMigrations: ReadonlyArray<AgentMigration> = [
  {
    digest: "sha256:8b183e9d29d45d336945ac79a74ad815a9c89608ef59442d53862fd66cd0aa89",
    sql: initialMigrationSql,
    version: 1,
  },
];

/** Result of bringing one Agent SQLite database to the requested migration version. */
export const AgentMigrationResult = Schema.Struct({
  appliedVersions: Schema.Array(Schema.Int),
  currentVersion: Schema.Natural,
});

/** Result of bringing one Agent SQLite database to the requested migration version. */
export type AgentMigrationResult = typeof AgentMigrationResult.Type;

const AppliedMigration = Schema.Struct({
  digest: Schema.String,
  version: Schema.Int,
});

type AppliedMigration = typeof AppliedMigration.Type;

/** Apply an immutable generated migration chain under exact SQLite transactions. */
export const applyMigrationChain = (
  storage: DurableObjectStorage,
  migrations: ReadonlyArray<AgentMigration>,
): Effect.Effect<AgentMigrationResult, AgentMigrationError> =>
  Effect.gen(function* () {
    yield* verifyDefinitions(migrations);
    yield* executeMigrationSql(0, () => {
      // Raw PRAGMA is a deliberate escape hatch. Drizzle has no clearer API for enabling FK enforcement.
      storage.sql.exec("PRAGMA foreign_keys = ON");
      // The ledger is coordinator-owned bootstrap state, so it must exist before Drizzle migrations run.
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS osfo_schema_migrations (
        version INTEGER PRIMARY KEY,
        digest TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT`);
    });

    const appliedRows = yield* executeMigrationSql(0, () =>
      // Ledger reads stay raw so the ledger cannot become part of application Drizzle schema or migrations.
      storage.sql
        .exec("SELECT version, digest FROM osfo_schema_migrations ORDER BY version")
        .toArray(),
    );
    const applied = yield* Schema.decodeUnknownEffect(Schema.Array(AppliedMigration))(
      appliedRows,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new AgentMigrationFailed({
            cause,
            message: "The Agent SQLite migration ledger is invalid",
            version: 0,
          }),
      ),
    );
    yield* verifyAppliedHistory(applied, migrations);

    const appliedVersions = new Set(applied.map(({ version }) => version));
    const newlyApplied: Array<number> = [];
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      yield* executeMigrationSql(migration.version, () =>
        // transactionSync is intentional. Generated DDL and its ledger row must commit as one sync unit.
        storage.transactionSync(() => {
          for (const statement of splitStatements(migration.sql)) storage.sql.exec(statement);
          storage.sql.exec(
            "INSERT INTO osfo_schema_migrations (version, digest) VALUES (?, ?)",
            migration.version,
            migration.digest,
          );
        }),
      );
      newlyApplied.push(migration.version);
    }

    return AgentMigrationResult.make({
      appliedVersions: newlyApplied,
      currentVersion: migrations.at(-1)?.version ?? 0,
    });
  });

/** Apply every Osfo-owned Agent SQLite migration supported by this release. */
export const applyAgentMigrations = (
  storage: DurableObjectStorage,
): Effect.Effect<AgentMigrationResult, AgentMigrationError> =>
  applyMigrationChain(storage, agentMigrations);

const verifyDefinitions = (
  migrations: ReadonlyArray<AgentMigration>,
): Effect.Effect<void, AgentMigrationDefinitionMismatch | AgentMigrationHistoryUnsupported> =>
  Effect.gen(function* () {
    for (const [index, migration] of migrations.entries()) {
      const expectedVersion = index + 1;
      if (migration.version !== expectedVersion) {
        return yield* new AgentMigrationHistoryUnsupported({
          message: "The Agent SQLite migration manifest is not a continuous version chain",
          version: migration.version,
        });
      }
      const actualDigest = yield* digestSql(migration.sql);
      if (actualDigest !== migration.digest) {
        return yield* new AgentMigrationDefinitionMismatch({
          actualDigest,
          expectedDigest: migration.digest,
          message: "Generated Agent SQLite migration SQL does not match its manifest digest",
          version: migration.version,
        });
      }
    }
    return undefined;
  });

const verifyAppliedHistory = (
  applied: ReadonlyArray<AppliedMigration>,
  migrations: ReadonlyArray<AgentMigration>,
): Effect.Effect<void, AgentMigrationDigestMismatch | AgentMigrationHistoryUnsupported> =>
  Effect.gen(function* () {
    for (const [index, stored] of applied.entries()) {
      const expectedVersion = index + 1;
      const definition = migrations[index];
      if (stored.version !== expectedVersion || definition === undefined) {
        return yield* new AgentMigrationHistoryUnsupported({
          message: "The Agent SQLite migration history is not a supported release prefix",
          version: stored.version,
        });
      }
      if (stored.digest !== definition.digest) {
        return yield* new AgentMigrationDigestMismatch({
          actualDigest: stored.digest,
          expectedDigest: definition.digest,
          message: "The applied Agent SQLite migration digest does not match this release",
          version: stored.version,
        });
      }
    }
    return undefined;
  });

const digestSql = (sqlText: string): Effect.Effect<string> =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(sqlText))).pipe(
    Effect.map((digest) => {
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return `sha256:${hex}`;
    }),
  );

const splitStatements = (sqlText: string): ReadonlyArray<string> =>
  sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

const executeMigrationSql = <T>(version: number, operation: () => T) =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      new AgentMigrationFailed({
        cause,
        message: "Agent SQLite rejected an Osfo migration operation",
        version,
      }),
  });
