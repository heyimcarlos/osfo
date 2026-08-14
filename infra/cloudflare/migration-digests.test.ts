import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";

import { verifyMigrationDirectory, verifyPostgresMigrationDigests } from "./migration-digests";

layer(NodeServices.layer)("Postgres migration digests", (it) => {
  it.effect("accepts the immutable released migration chain", () =>
    verifyPostgresMigrationDigests(),
  );

  it.effect("rejects an edited released migration", () =>
    Effect.gen(function* () {
      const mismatch = yield* Effect.flip(
        verifyMigrationDirectory("./packages/db/src/migrations", {
          "0000_demonic_doorman.sql": "edited-digest",
        }),
      );

      // oxlint-disable-next-line vitest/no-standalone-expect -- Effect layer callback is the test block
      expect(mismatch).toMatchObject({
        _tag: "MigrationDigestMismatch",
        directory: "./packages/db/src/migrations",
      });
    }),
  );
});
