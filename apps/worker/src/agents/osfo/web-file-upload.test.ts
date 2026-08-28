import { expect, it } from "@effect/vitest";

import { RetainedFileLimitExceeded } from "./db/file-store";
import { FileComputeFailed } from "../../services/files";
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

it("classifies disposable compute dependency failures as retryable", () => {
  expect(
    WebFileUpload.rejectionReasonForFailure(
      new FileComputeFailed({
        basis: null,
        kind: "dependency_unavailable",
        message: "The disposable compute dependency is unavailable",
        reason: "parser_failure",
        vendorUsdMicros: 0n,
      }),
    ),
  ).toBe("unavailable");
});

it("keeps compute content and parser rejections non-retryable", () => {
  for (const reason of ["content_limit", "malicious", "parser_failure"] as const) {
    expect(
      WebFileUpload.rejectionReasonForFailure(
        new FileComputeFailed({
          basis: null,
          kind: "task_rejected",
          message: "The supplied file was rejected",
          reason,
          vendorUsdMicros: 0n,
        }),
      ),
    ).toBe("invalid");
  }
});
