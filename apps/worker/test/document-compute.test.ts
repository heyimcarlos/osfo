import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { ContentId } from "../src/domain/client-content";
import { AllowancePeriodId } from "../src/domain";
import * as DocumentCompute from "../src/integrations/cloudflare/document-compute";
import { attemptKeyFor } from "../src/integrations/cloudflare/document-storage-keys";
import { DocumentIntentDigest, DocumentSource } from "../src/services/document-generation";

/* oxlint-disable eslint/no-underscore-dangle -- Test assertions use domain discriminators. */

describe("Cloudflare document compute", () => {
  it.effect("claims one durable R2 cost identity before execution", () =>
    Effect.gen(function* () {
      const contentId = ContentId.make("document:toolCall:compute-r2-attempt-176");
      const store = DocumentCompute.makeAttemptEvidenceStore(env.ARTIFACTS);
      yield* Effect.promise(() => env.ARTIFACTS.delete(attemptKeyFor(contentId)));

      const first = yield* Effect.promise(() =>
        store.claim(
          contentId,
          "4".repeat(64),
          incurred("period-first", "first", 12_000n),
          4_102_444_800_000,
        ),
      );
      const retry = yield* Effect.promise(() =>
        store.claim(
          contentId,
          "4".repeat(64),
          incurred("period-second", "second", 99_000n),
          4_102_444_800_000,
        ),
      );
      const conflict = yield* Effect.promise(() =>
        store.claim(
          contentId,
          "5".repeat(64),
          incurred("period-third", "third", 12_000n),
          4_102_444_800_000,
        ),
      );

      expect(first).toMatchObject({ created: true });
      expect(retry).toMatchObject({
        created: false,
        evidence: {
          cost: {
            allowancePeriodId: "period-first",
            providerOperationId: "first",
            usdMicros: 12_000n,
          },
          renderedPageCount: null,
        },
      });
      expect(conflict).toEqual({ _tag: "IntentConflict" });
      const pending = yield* DocumentCompute.readReconciliationBatch(env.ARTIFACTS);
      expect(pending.costs).toContainEqual(incurred("period-first", "first", 12_000n));
      yield* Effect.promise(() => env.ARTIFACTS.delete(attemptKeyFor(contentId)));
    }),
  );

  it.effect("persists one incurred-cost identity before an interrupted execution retry", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const events: Array<"claim" | "exec"> = [];
      let calls = 0;
      const client = fakeSandbox({
        exec: () => {
          calls += 1;
          events.push("exec");
          return calls === 1
            ? Promise.reject(new Error("connection lost"))
            : Promise.resolve({ exitCode: 137, stdout: "", success: false });
        },
        files,
      });
      const attempts = fakeAttemptEvidenceStore(events);
      const compute = DocumentCompute.makeWithSandbox(() => client, attempts, 12_000n);

      const first = yield* compute.generate(input);
      yield* TestClock.adjust(600_001);
      const second = yield* compute.generate(input);

      expect(first).toMatchObject({ _tag: "Interrupted" });
      expect(second).toMatchObject({ _tag: "Interrupted" });
      expect(calls).toBe(1);
      expect(events).toEqual(["claim", "exec", "claim"]);
      expect(second).toMatchObject({ cost: first.cost });
    }),
  );

  it.effect("proves no provider use when durable attempt persistence fails", () =>
    Effect.gen(function* () {
      let sandboxCalls = 0;
      const client = fakeSandbox({
        files: new Map(),
        exec: () => {
          sandboxCalls += 1;
          return Promise.reject(new Error("must not execute"));
        },
      });
      const attempts: DocumentCompute.AttemptEvidenceStore = {
        claim: () => Promise.reject(new Error("R2 unavailable")),
        complete: () => Promise.resolve(),
        inspect: () => Promise.resolve(null),
        start: () => Promise.resolve(true),
      };
      const compute = DocumentCompute.makeWithSandbox(() => client, attempts, 12_000n);

      const result = yield* compute.generate(input);

      expect(result).toMatchObject({
        _tag: "AttemptUnavailable",
        cost: { _tag: "ProvenNoUse" },
      });
      expect(sandboxCalls).toBe(0);
    }),
  );

  it.effect("does not rerun completed compute when its Sandbox output is missing", () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = fakeSandbox({
        exec: () => {
          calls += 1;
          return Promise.resolve({ exitCode: 0, stdout: '{"renderedPageCount":1}', success: true });
        },
        files: new Map(),
      });
      const attempts: DocumentCompute.AttemptEvidenceStore = {
        claim: () =>
          Promise.resolve({
            _tag: "Claimed",
            created: false,
            evidence: {
              cost: incurred("period-completed", "stable-completed-attempt", 12_000n),
              executionLeaseExpiresAt: 4_102_444_800_000,
              intentDigest: input.intentDigest,
              renderedPageCount: 1,
              status: "completed",
            },
            revision: "completed-revision",
          }),
        complete: () => Promise.resolve(),
        inspect: () => Promise.resolve(null),
        start: () => Promise.resolve(true),
      };
      const compute = DocumentCompute.makeWithSandbox(() => client, attempts, 12_000n);

      const result = yield* compute.generate(input);

      expect(result).toMatchObject({
        _tag: "Interrupted",
        cost: { providerOperationId: "stable-completed-attempt" },
      });
      expect(calls).toBe(0);
    }),
  );

  it.effect("recovers completed compute from the still-present Sandbox output", () =>
    Effect.gen(function* () {
      const files = new Map([[`/workspace/document-${input.intentDigest}.pdf`, "present"]]);
      let calls = 0;
      const bytes = new Uint8Array([1, 2, 3]);
      const client = fakeSandbox({
        exec: () => {
          calls += 1;
          return Promise.resolve({ exitCode: 0, stdout: "", success: true });
        },
        files,
        readStream: () =>
          Promise.resolve({ content: new Blob([bytes]).stream(), size: bytes.byteLength }),
      });
      const attempts = fakeAttemptEvidenceStore();
      yield* Effect.promise(() =>
        attempts.complete(input.contentId, {
          cost: incurred("period-completed", "stable-completed", 12_000n),
          executionLeaseExpiresAt: 4_102_444_800_000,
          intentDigest: input.intentDigest,
          renderedPageCount: 1,
          status: "completed",
        }),
      );
      const compute = DocumentCompute.makeWithSandbox(() => client, attempts, 99_000n);

      const result = yield* compute.generate(input);

      expect(result).toMatchObject({
        _tag: "Completed",
        cost: {
          allowancePeriodId: "period-completed",
          providerOperationId: "stable-completed",
          usdMicros: 12_000n,
        },
      });
      expect(calls).toBe(0);
    }),
  );

  it.effect("rejects an oversized Sandbox file before its stream is materialized", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      let streamPulls = 0;
      const client = fakeSandbox({
        exec: () =>
          Promise.resolve({ exitCode: 0, stdout: '{"renderedPageCount":1}', success: true }),
        files,
        readStream: () =>
          Promise.resolve({
            content: new ReadableStream(
              {
                pull: () => {
                  streamPulls += 1;
                },
              },
              { highWaterMark: 0 },
            ),
            size: 5_000_001,
          }),
      });
      const compute = DocumentCompute.makeWithSandbox(
        () => client,
        fakeAttemptEvidenceStore(),
        12_000n,
      );

      const result = yield* compute.generate(input);

      expect(result).toMatchObject({ _tag: "RejectedOversize", size: 5_000_001 });
      expect(streamPulls).toBe(0);
    }),
  );

  it.effect("returns a typed failure when Sandbox destruction is not confirmed", () =>
    Effect.gen(function* () {
      const client = fakeSandbox({
        destroy: () => Promise.reject(new Error("destroy failed")),
        files: new Map(),
      });
      const compute = DocumentCompute.makeWithSandbox(
        () => client,
        fakeAttemptEvidenceStore(),
        12_000n,
      );

      const error = yield* compute.dispose(input.contentId).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "DocumentCleanupUnavailable" });
    }),
  );

  it.effect("returns a typed cleanup failure when Sandbox destruction does not settle", () =>
    Effect.gen(function* () {
      const client = fakeSandbox({
        // oxlint-disable-next-line effecttsgo/new-promise -- This boundary fake must model a hung SDK Promise.
        destroy: () => new Promise<void>(() => undefined),
        files: new Map(),
      });
      const compute = DocumentCompute.makeWithSandbox(
        () => client,
        fakeAttemptEvidenceStore(),
        12_000n,
        { cleanupMs: 1, execMs: 10, rpcMs: 10 },
      );

      const error = yield* compute.dispose(input.contentId).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "DocumentCleanupUnavailable" });
    }),
  );

  it.effect("does not read Sandbox output after durable completion exceeds its deadline", () =>
    Effect.gen(function* () {
      let readCalls = 0;
      const attempts: DocumentCompute.AttemptEvidenceStore = {
        ...fakeAttemptEvidenceStore(),
        // oxlint-disable-next-line effecttsgo/new-promise -- This boundary fake must model a hung R2 Promise.
        complete: () => new Promise<void>(() => undefined),
      };
      const client = fakeSandbox({
        exec: () =>
          Promise.resolve({ exitCode: 0, stdout: '{"renderedPageCount":1}', success: true }),
        files: new Map(),
        readStream: () => {
          readCalls += 1;
          return Promise.resolve({ content: new Blob().stream(), size: 0 });
        },
      });
      const compute = DocumentCompute.makeWithSandbox(() => client, attempts, 12_000n, {
        cleanupMs: 10,
        execMs: 10,
        rpcMs: 1,
      });

      const result = yield* compute.generate(input);

      expect(result).toMatchObject({ _tag: "Interrupted" });
      expect(readCalls).toBe(0);
    }),
  );

  it.effect("advances bounded reconciliation beyond the first R2 page", () =>
    Effect.gen(function* () {
      const store = DocumentCompute.makeAttemptEvidenceStore(env.ARTIFACTS);
      yield* DocumentCompute.advanceReconciliation(env.ARTIFACTS, null);
      const contentIds = Array.from({ length: 101 }, (_, index) =>
        ContentId.make(`document:toolCall:reconciliation-${index.toString().padStart(3, "0")}`),
      );
      yield* Effect.forEach(
        contentIds,
        (contentId, index) =>
          // oxlint-disable-next-line effecttsgo/async-function -- The fake R2 store is Promise-based.
          Effect.promise(async () => {
            const claimed = await store.claim(
              contentId,
              "8".repeat(64),
              incurred("period-reconciliation", `operation-${index}`, 12_000n),
              4_102_444_800_000,
            );
            if (claimed._tag === "Claimed") {
              await store.start(
                contentId,
                { ...claimed.evidence, status: "started" },
                claimed.revision,
              );
            }
          }),
        { concurrency: 20, discard: true },
      );

      const first = yield* DocumentCompute.readReconciliationBatch(env.ARTIFACTS);
      yield* DocumentCompute.advanceReconciliation(env.ARTIFACTS, first.checkpoint);
      const second = yield* DocumentCompute.readReconciliationBatch(env.ARTIFACTS);

      expect(first.costs).toHaveLength(100);
      expect(second.costs).toHaveLength(1);
      yield* Effect.promise(() =>
        env.ARTIFACTS.delete(contentIds.map((contentId) => attemptKeyFor(contentId))),
      );
      yield* DocumentCompute.advanceReconciliation(env.ARTIFACTS, null);
    }),
  );

  it.effect("allows only one concurrent caller to execute Sandbox", () =>
    Effect.gen(function* () {
      const contentId = ContentId.make("document:toolCall:concurrent-compute-176");
      yield* Effect.promise(() => env.ARTIFACTS.delete(attemptKeyFor(contentId)));
      let executions = 0;
      const client = fakeSandbox({
        exec: () => {
          executions += 1;
          return Promise.resolve({ exitCode: 137, stdout: "", success: false });
        },
        files: new Map(),
      });
      const compute = DocumentCompute.makeWithSandbox(
        () => client,
        DocumentCompute.makeAttemptEvidenceStore(env.ARTIFACTS),
        12_000n,
      );
      const concurrentInput = { ...input, contentId };

      yield* Effect.all([compute.generate(concurrentInput), compute.generate(concurrentInput)], {
        concurrency: "unbounded",
      });

      expect(executions).toBe(1);
      yield* Effect.promise(() => env.ARTIFACTS.delete(attemptKeyFor(contentId)));
    }),
  );

  it.effect("keeps a slow live owner protected inside the bounded lease window", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let executions = 0;
      const client = fakeSandbox({
        exec: () => {
          executions += 1;
          // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- The fake adapts a Promise SDK boundary to test-controlled Deferred gates.
          return Effect.runPromise(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ exitCode: 137, stdout: "", success: false }),
            ),
          );
        },
        files: new Map(),
      });
      const compute = DocumentCompute.makeWithSandbox(
        () => client,
        fakeAttemptEvidenceStore(),
        12_000n,
      );
      const owner = yield* Effect.forkChild(compute.generate(input));
      yield* Deferred.await(entered);
      yield* TestClock.adjust(5 * 60_000);

      const concurrent = yield* compute.generate(input);

      expect(concurrent).toMatchObject({ _tag: "AttemptPending" });
      expect(executions).toBe(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);
    }),
  );
});

const fakeAttemptEvidenceStore = (
  events?: Array<"claim" | "exec">,
): DocumentCompute.AttemptEvidenceStore => {
  const evidence = new Map<ContentId, DocumentCompute.AttemptEvidence>();
  return {
    claim: (contentId, intentDigest, cost, executionLeaseExpiresAt) => {
      events?.push("claim");
      const existing = evidence.get(contentId);
      if (existing !== undefined) {
        return Promise.resolve({
          _tag: "Claimed" as const,
          created: false,
          evidence: existing,
          revision: "fake-revision",
        });
      }
      const created = {
        cost,
        executionLeaseExpiresAt,
        intentDigest,
        renderedPageCount: null,
        status: "started" as const,
      };
      evidence.set(contentId, created);
      return Promise.resolve({
        _tag: "Claimed" as const,
        created: true,
        evidence: created,
        revision: "fake-revision",
      });
    },
    complete: (contentId, completed) => {
      evidence.set(contentId, completed);
      return Promise.resolve();
    },
    inspect: (contentId) => Promise.resolve(evidence.get(contentId) ?? null),
    start: (contentId, started) => {
      evidence.set(contentId, started);
      return Promise.resolve(true);
    },
  };
};

const input = {
  allowancePeriodId: AllowancePeriodId.make("period-compute-176"),
  contentId: ContentId.make("document:toolCall:compute-176"),
  format: "pdf" as const,
  intentDigest: DocumentIntentDigest.make("4".repeat(64)),
  source: DocumentSource.make({ pages: [{ lines: ["Content"], title: "Title" }] }),
};

const incurred = (period: string, providerOperationId: string, usdMicros: bigint) => ({
  _tag: "Incurred" as const,
  allowancePeriodId: AllowancePeriodId.make(period),
  basis: "conservative" as const,
  providerOperationId,
  usdMicros,
});

const fakeSandbox = (options: {
  readonly destroy?: () => Promise<void>;
  readonly exec?: DocumentCompute.SandboxClient["exec"];
  readonly files: Map<string, string>;
  readonly readStream?: DocumentCompute.SandboxClient["readStream"];
}): DocumentCompute.SandboxClient => ({
  destroy: options.destroy ?? (() => Promise.resolve()),
  exec: options.exec ?? (() => Promise.resolve({ exitCode: 1, stdout: "", success: false })),
  exists: (path) => Promise.resolve({ exists: options.files.has(path) }),
  readStream: options.readStream ?? (() => Promise.reject(new Error("No output stream"))),
  readText: (path) => {
    const content = options.files.get(path);
    return content === undefined
      ? Promise.reject(new Error("File not found"))
      : Promise.resolve(content);
  },
  writeFile: (path, content) => {
    options.files.set(path, content);
    return Promise.resolve();
  },
});
