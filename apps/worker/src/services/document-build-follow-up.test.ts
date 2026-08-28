import { describe, expect, it } from "@effect/vitest";

import { DocumentBuildFollowUp } from "./document-build-follow-up";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- The Promise queue models Agent serialization and uses one fixed product timestamp. */

describe("DocumentBuildFollowUp submission disposition", () => {
  it("derives concurrent replay truth from each refreshed serialized notification", async () => {
    let acceptedAt: Date | null = null;
    let serialized = Promise.resolve();
    const submit = () => {
      const outcome = serialized.then(() => {
        const disposition = DocumentBuildFollowUp.submissionDisposition({ acceptedAt });
        acceptedAt ??= new Date("2026-08-28T12:00:00.000Z");
        return disposition;
      });
      serialized = outcome.then(() => undefined);
      return outcome;
    };

    await expect(Promise.all([submit(), submit()])).resolves.toEqual(["Accepted", "Replayed"]);
  });
});
