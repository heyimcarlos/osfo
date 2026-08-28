/* oxlint-disable effecttsgo/async-function, effecttsgo/prefer-schema-over-json, vitest/no-standalone-expect -- Promise and serialized-file fakes model the Sandbox SDK boundary; assertions execute inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { FileDigest } from "../../domain/file-content";
import { launchFileComputeLimits } from "../../services/files";
import { makeFileCompute, sandboxIdFor } from "./file-compute";

it("derives stable, distinct Sandbox-safe identities from long logical File task scopes", () => {
  const logical = `normalization-${"user".repeat(20)}-${"file".repeat(20)}`;
  const first = sandboxIdFor(logical);
  const replay = sandboxIdFor(logical);
  const second = sandboxIdFor(`${logical}-other`);

  expect(first).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u);
  expect(first).toHaveLength(63);
  expect(replay).toBe(first);
  expect(second).not.toBe(first);
});

it.effect(
  "preserves one logical identity across normalize, reconcile, and release boundaries",
  () =>
    Effect.gen(function* () {
      const resolved: Array<string> = [];
      const destroyed: Array<string> = [];
      let result = JSON.stringify({ normalizedText: "bounded text", ok: true, parser: "text" });
      const compute = makeFileCompute((taskScope) => {
        resolved.push(taskScope);
        return {
          destroy: async () => void destroyed.push(taskScope),
          exec: async () => ({ success: true }),
          readFile: async () => ({ content: result }),
          writeFile: async () => undefined,
        };
      });
      const normalizationScope = `normalization-${"n".repeat(90)}`;
      const analysisScope = `analysis-${"a".repeat(90)}`;

      const normalized = yield* compute.normalize({
        bytes: new TextEncoder().encode("bounded text"),
        conservativeVendorUsdMicros: 0n,
        limits: launchFileComputeLimits,
        mediaType: "text/plain",
        sha256: FileDigest.make(`sha256:${"a".repeat(64)}`),
        taskScope: normalizationScope,
      });
      result = JSON.stringify({ ok: true, resultText: "analysis result" });
      const reconciled = yield* compute.reconcileAnalysis(analysisScope);
      yield* compute.releaseAnalysis(analysisScope);

      expect(normalized.normalizedText).toBe("bounded text");
      expect(reconciled).toMatchObject({ _tag: "AnalysisCompleted" });
      expect(resolved).toEqual([normalizationScope, analysisScope, analysisScope]);
      expect(destroyed).toEqual([normalizationScope, analysisScope]);
      expect(sandboxIdFor(analysisScope)).toBe(sandboxIdFor(analysisScope));
    }),
);
