import { Effect, Schema } from "effect";

import initialMigrationSql from "./migrations/0000_silky_goblin_queen.sql";
import modelCallUsageMigrationSql from "./migrations/0001_youthful_dreadnoughts.sql";
import acceptanceReceiptMigrationSql from "./migrations/0002_absurd_unus.sql";
import sessionRecallMigrationSql from "./migrations/0003_typical_sir_ram.sql";
import fileCapabilityMigrationSql from "./migrations/0004_sudden_invaders.sql";
import transportReceiptRemovalMigrationSql from "./migrations/0005_tidy_james_howlett.sql";
import memoryProviderOutboxMigrationSql from "./migrations/0006_perpetual_skaar.sql";
import structuredConversationIngestionMigrationSql from "./migrations/0007_red_fantastic_four.sql";
import conversationProcessingBarrierMigrationSql from "./migrations/0008_little_adam_warlock.sql";
import memoryProviderConfigurationMigrationSql from "./migrations/0009_absent_typhoid_mary.sql";
import memoryProviderDeletionProgressMigrationSql from "./migrations/0010_yellow_living_mummy.sql";
import providerSubmissionAmbiguityMigrationSql from "./migrations/0011_misty_quentin_quire.sql";
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
    digest: "sha256:6cc13367470fba28ea86d561b868283b79e218cf50dc759796821e49a3a76b2c",
    sql: initialMigrationSql,
    version: 1,
  },
  {
    digest: "sha256:3b6a404b5be6818b7a5dd39f264164e1e586574a066e25ab6b9fa5cf79e56be3",
    sql: modelCallUsageMigrationSql,
    version: 2,
  },
  {
    digest: "sha256:81d2adf32670669d854f3e48d6a505e1d99477b0499694df1a8c4790e81f56e8",
    sql: acceptanceReceiptMigrationSql,
    version: 3,
  },
  {
    digest: "sha256:836084dbf2a422bdbd031c67a51511cc025651bf2ccf2e4ad860eff5b11f7fe7",
    sql: sessionRecallMigrationSql,
    version: 4,
  },
  {
    digest: "sha256:d5c80c790098fdb3a41c5c623ab35c06da863a39b2f585d6bb1b279b8e661f62",
    sql: fileCapabilityMigrationSql,
    version: 5,
  },
  {
    digest: "sha256:db33de4b3d6accce7384198dd43143dcd7ccc6d179d2f5fd86cfec5a885a5ec0",
    sql: transportReceiptRemovalMigrationSql,
    version: 6,
  },
  {
    digest: "sha256:e73b45242dc024fa5e2b7b36d1eb7dd7dddccd413f99ea33695be8ed548b1b9f",
    sql: memoryProviderOutboxMigrationSql,
    version: 7,
  },
  {
    digest: "sha256:8ace81730e97abe4559c6c4f2af78a77ca05fe68cc24b219363fe0cea85abbcc",
    sql: structuredConversationIngestionMigrationSql,
    version: 8,
  },
  {
    digest: "sha256:11a8848f681535447f4d6d424a2d13f6f474c0f2f949b14fb89ab785ddd873f5",
    sql: conversationProcessingBarrierMigrationSql,
    version: 9,
  },
  {
    digest: "sha256:d2db4bb6439c7099be0200c707b1accb481ebb4a5e542c18fc5692fc7824903e",
    sql: memoryProviderConfigurationMigrationSql,
    version: 10,
  },
  {
    digest: "sha256:da5f5abdbc33793494a9f1ebfe6b520edf2becaaef3afe18ad24421e0d4e8669",
    sql: memoryProviderDeletionProgressMigrationSql,
    version: 11,
  },
  {
    digest: "sha256:d3716616805ee5d1e36ab9050e1c92787b3a06cb4057bfc807e307906b1713aa",
    sql: providerSubmissionAmbiguityMigrationSql,
    version: 12,
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
