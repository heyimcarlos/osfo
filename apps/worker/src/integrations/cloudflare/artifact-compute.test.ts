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
    start: async (_contentId, evidence) => {
      retained = evidence;
      return true;
    },
  };
  const never: ImageProvider = { generate: () => new Promise(() => undefined) };
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
