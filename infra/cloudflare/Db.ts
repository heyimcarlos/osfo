import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Config, ConfigProvider, DateTime, Effect } from "effect";

const migrationsDir = "./packages/db/src/migrations";

/** Shared Neon project and stage-specific database branch used by Osfo. */
export const Db = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  if (stage !== "development" && stage !== "production" && !/^pr-[1-9]\d*$/.test(stage)) {
    return yield* Effect.fail(
      new Config.ConfigError(
        new ConfigProvider.SourceError({
          message: `Unsupported deployment stage "${stage}". Use development, production, or pr-<positive-number>`,
        }),
      ),
    );
  }

  const project =
    stage === "production"
      ? yield* Neon.Project("OsfoProject", {
          defaultBranchName: "production",
          migrationsDir,
          name: "osfo.ai",
          orgId: yield* Config.string("NEON_ORG_ID"),
          pgVersion: 18,
          region: "aws-us-east-1",
        }).pipe(RemovalPolicy.retain())
      : yield* Neon.Project.ref("OsfoProject", { stage: "production" });

  if (stage === "production") {
    return {
      branchId: project.defaultBranchId,
      database: project,
    };
  }

  const branch =
    stage === "development"
      ? yield* Neon.Branch("DevelopmentBranch", {
          migrationsDir,
          name: "development",
          parentBranch: { name: "production" },
          project,
        }).pipe(RemovalPolicy.retain())
      : yield* Effect.gen(function* () {
          const now = yield* DateTime.now;
          return yield* Neon.Branch("PreviewBranch", {
            expiresAt: DateTime.formatIso(DateTime.add(now, { days: 7 })),
            migrationsDir,
            name: `preview/${stage}`,
            parentBranch: { name: "production" },
            project,
          });
        });

  return {
    branchId: branch.branchId,
    database: branch,
  };
});

/** Cloudflare Hyperdrive connection for the active Neon database branch. */
export const Hyperdrive = Effect.gen(function* () {
  const { database } = yield* Db;
  return yield* Cloudflare.Hyperdrive.Connection("DatabaseHyperdrive", {
    caching: { disabled: true },
    dev: database.pooledOrigin,
    origin: database.origin,
  });
});
