import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ThreeTabJourneySchema, startThreeTabEvidenceCapture } from "./three-tab-evidence.js";

describe("three-tab evidence capture seam", () => {
  it.effect("is a side-effect-free no-op when the evidence directory is unset", () =>
    Effect.gen(function* () {
      let cdpCalls = 0;
      const tabs = ["A", "B", "C"].map((label) => ({
        label,
        configureEvidenceViewport: () =>
          Effect.sync(() => {
            cdpCalls += 1;
          }),
        captureEvidenceFrame: () =>
          Effect.sync(() => {
            cdpCalls += 1;
            return Buffer.from("not a real frame");
          }),
      }));

      const capture = yield* startThreeTabEvidenceCapture({ directory: undefined, tabs });
      yield* capture.mark("initial-synchronized", {});
      yield* capture.stop;

      expect(cdpCalls).toBe(0);
      expect(capture.enabled).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects authentication tokens in semantic journey output", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        Schema.decodeUnknownEffect(ThreeTabJourneySchema)({
          schemaVersion: 1,
          proofScope:
            "authenticated independent observer-tab disconnect and cursor resume; sender-close-mid-response is not exercised",
          framesPerSecond: 4,
          viewport: { width: 640, height: 960 },
          startedAt: "2026-08-07T10:00:00.000Z",
          endedAt: "2026-08-07T10:00:05.000Z",
          authenticationToken: "must-not-be-written",
          events: [],
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );
});
