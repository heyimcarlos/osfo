/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise, eslint/no-underscore-dangle, vitest/no-standalone-expect -- Promise fakes model external adapters and assertions execute inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import { ContentId } from "../../domain/client-content";
import { ArtifactIntentDigest } from "../../services/artifact-generation";
import {
  makeWithPorts,
  type AttemptStore,
  type ImageProvider,
  type SandboxClient,
} from "./artifact-compute";

const request = {
  allowancePeriodId: AllowancePeriodId.make("period-1"),
  computeMilliseconds: 60_000,
  contentId: ContentId.make("artifact:toolCall:compute-1"),
  intent: {
    _tag: "Diagram" as const,
    source: {
      direction: "leftToRight" as const,
      edges: [{ from: "one", label: "", to: "two" }],
      height: 400,
      nodes: [
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
      ],
      title: "Flow",
      width: 600,
    },
  },
  intentDigest: ArtifactIntentDigest.make("a".repeat(64)),
  sourceArtifact: null,
  supportingVisuals: [],
  userId: UserId.make("user-1"),
};

it.effect("moves immutable attempt evidence from no-use claim to incurred completion", () => {
  let retained: Parameters<AttemptStore["claim"]>[1] | null = null;
  const statuses: Array<string> = [];
  const attempts: AttemptStore = {
    claim: async (_contentId, evidence) => {
      retained = evidence;
      statuses.push(evidence.status);
      return { _tag: "Claimed", evidence };
    },
    complete: async (_contentId, evidence) => {
      retained = evidence;
      statuses.push(evidence.status);
    },
    inspect: async () => retained,
    readCompleted: async () => bytes,
    reclaim: async () => false,
    start: async (_contentId, evidence) => {
      retained = evidence;
      statuses.push(evidence.status);
      return true;
    },
  };
  const bytes = new Uint8Array([1, 2, 3]);
  const sandbox = successfulSandbox(bytes);
  const compute = makeWithPorts(() => sandbox, attempts, { generate: async () => bytes }, 50_000n);

  return compute.generate(request).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result._tag).toBe("Completed");
        expect(statuses).toEqual(["claimed", "started", "completed"]);
        expect(retained?.cost._tag).toBe("Incurred");
      }),
    ),
  );
});

it.effect("bounds a non-responsive image provider after durable incurred evidence starts", () => {
  let retained: Parameters<AttemptStore["claim"]>[1] | null = null;
  const attempts: AttemptStore = {
    claim: async (_contentId, evidence) => {
      retained = evidence;
      return { _tag: "Claimed", evidence };
    },
    complete: async (_contentId, evidence) => {
      retained = evidence;
    },
    inspect: async () => retained,
    readCompleted: async () => new Uint8Array([1]),
    reclaim: async () => false,
    start: async (_contentId, evidence) => {
      retained = evidence;
      return true;
    },
  };
  let providerAborted = false;
  const never: ImageProvider = {
    generate: (_source, signal) => {
      signal.addEventListener("abort", () => {
        providerAborted = true;
      });
      return new Promise(() => undefined);
    },
  };
  const compute = makeWithPorts(
    () => successfulSandbox(new Uint8Array([1])),
    attempts,
    never,
    50_000n,
    { cleanupMs: 5, execMs: 5, rpcMs: 5 },
  );

  return compute
    .generate({
      ...request,
      intent: {
        _tag: "Image",
        source: { altText: "A bounded image", height: 400, prompt: "A potato", width: 600 },
      },
    })
    .pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toMatchObject({ _tag: "Interrupted", cost: { _tag: "Incurred" } });
          expect(retained).toMatchObject({ cost: { _tag: "Incurred" }, status: "started" });
          expect(providerAborted).toBe(true);
        }),
      ),
    );
});

it.effect("replays a digest-verified completed output without another Sandbox execution", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  let executions = 0;
  const completed = {
    cost: {
      _tag: "Incurred" as const,
      allowancePeriodId: request.allowancePeriodId,
      basis: "conservative" as const,
      providerOperationId: "artifact:completed",
      usdMicros: 50_000n,
    },
    executionLeaseExpiresAt: -1,
    intentDigest: request.intentDigest,
    output: {
      byteLength: bytes.byteLength,
      inspection: { _tag: "Visual" as const, height: 400, width: 600 },
      sha256: "a".repeat(64),
    },
    status: "completed" as const,
    userId: request.userId,
  };
  const attempts: AttemptStore = {
    claim: async () => ({ _tag: "Existing", evidence: completed }),
    complete: async () => undefined,
    inspect: async () => completed,
    readCompleted: async () => bytes,
    reclaim: async () => false,
    start: async () => false,
  };
  const sandbox = {
    ...successfulSandbox(bytes),
    exec: async () => {
      executions += 1;
      return { exitCode: 0, stdout: "", success: true };
    },
  };
  const compute = makeWithPorts(() => sandbox, attempts, { generate: async () => bytes }, 50_000n);

  return compute.generate(request).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toMatchObject({ _tag: "Completed", cost: { _tag: "Incurred" } });
        expect(executions).toBe(0);
      }),
    ),
  );
});

it.effect("fails closed when staged completed output no longer matches its digest", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const completed = {
    cost: {
      _tag: "Incurred" as const,
      allowancePeriodId: request.allowancePeriodId,
      basis: "conservative" as const,
      providerOperationId: "artifact:corrupt",
      usdMicros: 50_000n,
    },
    executionLeaseExpiresAt: -1,
    intentDigest: request.intentDigest,
    output: {
      byteLength: bytes.byteLength,
      inspection: { _tag: "Visual" as const, height: 400, width: 600 },
      sha256: "a".repeat(64),
    },
    status: "completed" as const,
    userId: request.userId,
  };
  const attempts: AttemptStore = {
    claim: async () => ({ _tag: "Existing", evidence: completed }),
    complete: async () => undefined,
    inspect: async () => completed,
    readCompleted: async () => {
      throw new Error("digest mismatch");
    },
    reclaim: async () => false,
    start: async () => false,
  };
  const compute = makeWithPorts(
    () => successfulSandbox(bytes),
    attempts,
    { generate: async () => bytes },
    50_000n,
  );

  return compute.generate(request).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toMatchObject({ _tag: "Interrupted", cost: { _tag: "Incurred" } });
      }),
    ),
  );
});

it.effect("atomically reclaims an expired started lease", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  let retained: Parameters<AttemptStore["claim"]>[1] = {
    cost: {
      _tag: "Incurred",
      allowancePeriodId: request.allowancePeriodId,
      basis: "conservative",
      providerOperationId: "artifact:expired",
      usdMicros: 50_000n,
    },
    executionLeaseExpiresAt: -1,
    intentDigest: request.intentDigest,
    output: null,
    status: "started",
    userId: request.userId,
  };
  let executions = 0;
  const attempts: AttemptStore = {
    claim: async () => ({ _tag: "Existing", evidence: retained }),
    complete: async (_contentId, evidence) => {
      retained = evidence;
    },
    inspect: async () => retained,
    readCompleted: async () => bytes,
    reclaim: async (_contentId, current, proposed) => {
      if (retained !== current) return false;
      retained = proposed;
      return true;
    },
    start: async (_contentId, evidence) => {
      retained = evidence;
      return true;
    },
  };
  const sandbox = {
    ...successfulSandbox(bytes),
    exec: async () => {
      executions += 1;
      return {
        exitCode: 0,
        stdout: '{"height":400,"kind":"visual","width":600}',
        success: true,
      };
    },
  };
  const compute = makeWithPorts(() => sandbox, attempts, { generate: async () => bytes }, 50_000n);

  return compute.generate(request).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result._tag).toBe("Completed");
        expect(executions).toBe(1);
        expect(retained.status).toBe("completed");
      }),
    ),
  );
});

const successfulSandbox = (bytes: Uint8Array): SandboxClient => ({
  destroy: async () => undefined,
  exec: async () => ({
    exitCode: 0,
    stdout: '{"height":400,"kind":"visual","width":600}',
    success: true,
  }),
  readStream: async () => ({
    content: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    size: bytes.byteLength,
  }),
  writeFile: async () => undefined,
});
