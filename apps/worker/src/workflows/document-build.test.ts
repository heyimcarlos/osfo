/* oxlint-disable vitest/no-standalone-expect -- Host stubs assert at their invocation boundary. */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { DocumentBuild } from "../services/document-build";
import {
  matchesInstanceIdentity,
  requireRetryForRecoverableResult,
} from "./document-build-host-outcome";

describe("DocumentBuildWorkflow host outcomes", () => {
  it("retries ambiguous and interrupted compute instead of terminalizing", () => {
    expect(() => requireRetryForRecoverableResult({ failure: "recovery" })).toThrow(
      "reconciliation is pending",
    );
    expect(() => requireRetryForRecoverableResult({ failure: "unavailable" })).toThrow(
      "temporarily unavailable",
    );
  });

  it("returns already committed terminal truth", () => {
    expect(
      requireRetryForRecoverableResult({
        artifactContentId: null,
        state: "canceled",
        workflowId: DocumentBuild.WorkflowId.make("document-build:terminal"),
      }),
    ).toMatchObject({ state: "canceled" });
  });

  it.effect("rejects a payload delivered to a different main instance before product effects", () =>
    Effect.gen(function* () {
      const payload = DocumentBuild.WorkflowPayload.make({
        inputDigest: DocumentBuild.InputDigest.make("a".repeat(64)),
        workflowId: DocumentBuild.WorkflowId.make("document-build:host-identity"),
      });
      const identities = yield* DocumentBuild.cloudflareInstanceIdsFor(payload.workflowId);
      expect(yield* matchesInstanceIdentity("main", identities.main, payload)).toBe(true);
      expect(yield* matchesInstanceIdentity("main", identities.timer, payload)).toBe(false);
    }),
  );
});
