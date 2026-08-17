import { describe, expect, it } from "@effect/vitest";

import {
  parseApprovalId,
  parseCaseId,
  parseEvidenceInstant,
  parseVersionId,
} from "../src/identity";

describe("Model Quality identities", () => {
  it("parses distinct non-empty identities and canonical evidence timestamps", () => {
    expect(parseCaseId("ordinary-001")).toMatchObject({ kind: "success" });
    expect(parseApprovalId("approval-001")).toMatchObject({ kind: "success" });
    expect(parseVersionId("model-quality-v1")).toMatchObject({ kind: "success" });
    expect(parseEvidenceInstant("2026-08-17T00:00:00.000Z")).toMatchObject({ kind: "success" });
    expect(parseCaseId("")).toMatchObject({ error: { _tag: "InvalidIdentity" }, kind: "error" });
    expect(parseEvidenceInstant("2026-08-17")).toMatchObject({
      error: { _tag: "InvalidIdentity" },
      kind: "error",
    });
  });
});
