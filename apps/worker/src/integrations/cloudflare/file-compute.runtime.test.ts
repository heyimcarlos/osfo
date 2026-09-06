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

it.effect("rejects normalized text that still exceeds the two MB compute limit", () =>
  Effect.gen(function* () {
    const oversized = "x".repeat(launchFileComputeLimits.maximumNormalizedTextBytes + 1);
    const compute = makeFileCompute(() => ({
      destroy: async () => undefined,
      exec: async () => ({ success: true }),
      readFile: async () => ({
        content: JSON.stringify({ normalizedText: oversized, ok: true, parser: "text" }),
      }),
      writeFile: async () => undefined,
    }));
    const result = yield* compute
      .normalize({
        bytes: new TextEncoder().encode("source"),
        conservativeVendorUsdMicros: 0n,
        limits: launchFileComputeLimits,
        mediaType: "text/plain",
        sha256: FileDigest.make(`sha256:${"a".repeat(64)}`),
        taskScope: "oversized-normalized-text",
      })
      .pipe(Effect.result);

    expect(result).toMatchObject({ failure: { reason: "content_limit" } });
  }),
);

it.effect.each([
  { pages: undefined, reason: "parser_failure" },
  { pages: [{ page: 1, method: "ocr", text: "x".repeat(2_000_001) }], reason: "content_limit" },
])("rejects missing or oversized PDF page evidence: $reason", ({ pages, reason }) =>
  Effect.gen(function* () {
    const compute = makeFileCompute(() => ({
      destroy: async () => undefined,
      exec: async () => ({ success: true }),
      writeFile: async () => undefined,
      readFile: async () => ({
        content: JSON.stringify({ ok: true, normalizedText: "short text", parser: "pdf", pages }),
      }),
    }));
    const result = yield* compute
      .normalize({
        bytes: new TextEncoder().encode("%PDF-synthetic"),
        conservativeVendorUsdMicros: 0n,
        limits: launchFileComputeLimits,
        mediaType: "application/pdf",
        sha256: FileDigest.make(`sha256:${"a".repeat(64)}`),
        taskScope: "page-evidence-limits",
      })
      .pipe(Effect.result);
    expect(result).toMatchObject({ failure: { reason } });
  }),
);

it.effect("retains page evidence with the original source digest", () =>
  Effect.gen(function* () {
    const pages = [{ page: 1, method: "ocr", text: "Reference: SAMPLE-4821" }];
    const compute = makeFileCompute(() => ({
      destroy: async () => undefined,
      exec: async () => ({ success: true }),
      writeFile: async () => undefined,
      readFile: async () => ({
        content: JSON.stringify({
          ok: true,
          normalizedText: "Reference: SAMPLE-4821",
          parser: "pdf",
          pages,
        }),
      }),
    }));
    const sha256 = FileDigest.make(`sha256:${"a".repeat(64)}`);
    const result = yield* compute.normalize({
      bytes: new TextEncoder().encode("%PDF-synthetic"),
      conservativeVendorUsdMicros: 0n,
      limits: launchFileComputeLimits,
      mediaType: "application/pdf",
      sha256,
      taskScope: "retained-page-evidence",
    });
    expect(result.provenance).toEqual({
      mediaType: "application/pdf",
      parser: "pdf",
      sourceSha256: sha256,
      pages,
    });
  }),
);

it.effect(
  "classifies a Sandbox startup or write outage as retryable dependency unavailability",
  () =>
    Effect.gen(function* () {
      const compute = makeFileCompute(() => ({
        destroy: async () => undefined,
        exec: async () => ({ success: true }),
        readFile: async () => ({
          content: JSON.stringify({ normalizedText: "source", ok: true, parser: "text" }),
        }),
        writeFile: async () => Promise.reject(new Error("Sandbox app did not start")),
      }));

      expect(
        yield* compute
          .normalize({
            bytes: new TextEncoder().encode("valid UTF-8 source"),
            conservativeVendorUsdMicros: 0n,
            limits: launchFileComputeLimits,
            mediaType: "text/plain",
            sha256: FileDigest.make(`sha256:${"a".repeat(64)}`),
            taskScope: "unavailable-sandbox",
          })
          .pipe(Effect.result),
      ).toMatchObject({
        failure: {
          _tag: "FileComputeFailed",
          kind: "dependency_unavailable",
          reason: "parser_failure",
        },
      });
    }),
);

it.effect("keeps malformed normalization output as a non-retryable task rejection", () =>
  Effect.gen(function* () {
    const compute = makeFileCompute(() => ({
      destroy: async () => undefined,
      exec: async () => ({ success: true }),
      readFile: async () => ({ content: "not valid task JSON" }),
      writeFile: async () => undefined,
    }));

    expect(
      yield* compute
        .normalize({
          bytes: new TextEncoder().encode("valid UTF-8 source"),
          conservativeVendorUsdMicros: 0n,
          limits: launchFileComputeLimits,
          mediaType: "text/plain",
          sha256: FileDigest.make(`sha256:${"a".repeat(64)}`),
          taskScope: "malformed-task-output",
        })
        .pipe(Effect.result),
    ).toMatchObject({
      failure: {
        _tag: "FileComputeFailed",
        kind: "task_rejected",
        reason: "parser_failure",
      },
    });
  }),
);

it.effect("keeps malformed reconciliation after an exec rejection retryable", () =>
  Effect.gen(function* () {
    const compute = makeFileCompute(() => ({
      destroy: async () => undefined,
      exec: async () => Promise.reject(new Error("Sandbox execution acknowledgement was lost")),
      readFile: async () => ({ content: "truncated task JSON" }),
      writeFile: async () => undefined,
    }));

    expect(
      yield* compute
        .normalize({
          bytes: new TextEncoder().encode("valid UTF-8 source"),
          conservativeVendorUsdMicros: 30_000n,
          limits: launchFileComputeLimits,
          mediaType: "text/plain",
          sha256: FileDigest.make(`sha256:${"a".repeat(64)}`),
          taskScope: "ambiguous-malformed-reconciliation",
        })
        .pipe(Effect.result),
    ).toMatchObject({
      failure: {
        basis: "conservative",
        kind: "dependency_unavailable",
        reason: "parser_failure",
        vendorUsdMicros: 30_000n,
      },
    });
  }),
);
