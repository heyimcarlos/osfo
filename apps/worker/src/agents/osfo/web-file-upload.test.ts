import { expect, it } from "@effect/vitest";

import { RetainedFileLimitExceeded } from "./db/file-store";
import { WebFileUpload } from "./web-file-upload";

it("preserves retained-file exhaustion as a dedicated non-retryable result", () => {
  expect(
    WebFileUpload.rejectionReasonForFailure(
      new RetainedFileLimitExceeded({
        attemptedBytes: 1n,
        limitBytes: 10n,
        message: "The retained file byte limit is exhausted",
        retainedBytes: 10n,
      }),
    ),
  ).toBe("limit");
});
