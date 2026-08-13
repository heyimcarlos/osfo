import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";

import { verifyD1MigrationDigests, verifyMigrationDirectory } from "./migration-digests";

layer(NodeServices.layer)("D1 migration digests", (it) => {
  it.effect("accepts the immutable released migration chain", () => verifyD1MigrationDigests());

  it.effect("rejects an edited released migration", () =>
    Effect.gen(function* () {
      const mismatch = yield* Effect.flip(
        verifyMigrationDirectory("./apps/worker/drizzle/directory", {
          "20260813020336_initial_directory/migration.sql": "edited-digest",
        }),
      );

      // oxlint-disable-next-line vitest/no-standalone-expect -- Effect layer callback is the test block
      expect(mismatch).toMatchObject({
        _tag: "MigrationDigestMismatch",
        directory: "./apps/worker/drizzle/directory",
      });
    }),
  );
});
