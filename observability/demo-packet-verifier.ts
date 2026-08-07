import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { NodeRuntime } from "@effect/platform-node";
import { Data, Effect, Schema } from "effect";

const InspectedOpenPokeRevision = "5b5f635935a64ab37884c025d70abb0ed731c094";
const InspectedOpenPokeRevisionReference =
  `[${InspectedOpenPokeRevision}]` +
  `(https://github.com/shlokkhemani/openpoke/tree/${InspectedOpenPokeRevision})`;
const OpenPokeSourceReferences = [
  ["ChatRequest", "server/models/chat.py#L26-L35"],
  ["chat_send", "server/routes/chat.py#L10-L45"],
  ["handle_chat_request", "server/services/conversation/chat_handler.py#L22-L49"],
  ["POST", "web/app/api/chat/route.ts#L22-L56"],
  ["InteractionAgentRuntime.execute", "server/agents/interaction_agent/runtime.py#L65-L89"],
  ["request_chat_completion", "server/openrouter_client/client.py#L49-L82"],
  ["sendMessage", "web/app/page.tsx#L110-L190"],
  ["ConversationLog", "server/services/conversation/log.py#L19-L82"],
  ["get_conversation_log", "server/services/conversation/log.py#L214-L218"],
  ["app", "server/app.py#L49-L83"],
  ["get_active_gmail_user_id", "server/services/gmail/client.py#L18-L40"],
  ["ensureUserId", "web/components/SettingsModal.tsx#L122-L149"],
  ["WorkingMemoryLog", "server/services/conversation/summarization/working_memory_log.py#L16-L48"],
  ["TriggerStore", "server/services/triggers/store.py#L13-L68"],
  ["TriggerScheduler", "server/services/trigger_scheduler.py#L26-L116"],
  ["ExecutionBatchManager", "server/agents/execution_agent/batch_manager.py#L36-L145"],
  ["requirements", "server/requirements.txt#L1-L7"],
  ["gmail_execute_draft", "server/agents/execution_agent/tools/gmail.py#L375-L427"],
  ["_execute", "server/agents/execution_agent/tools/gmail.py#L324-L343"],
  ["execute_gmail_tool", "server/services/gmail/client.py#L466-L494"],
] as const;

const EvidenceStatusSchema = Schema.Literals(["PASS", "FAIL", "MISSING"]);
const ArtifactKindSchema = Schema.Literals([
  "sealed-run",
  "dashboard-view",
  "recording",
  "post-run-render",
  "document",
  "source-manifest",
]);
const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const SourceManifestPathSchema = Schema.String.check(Schema.isPattern(/^\.\/[^\r\n]+$/u));
const SourceManifestEntrySchema = Schema.Struct({
  sha256: Sha256Schema,
  path: SourceManifestPathSchema,
});

const PresentArtifactSchema = Schema.Struct({
  id: Schema.String,
  kind: ArtifactKindSchema,
  artifactStatus: Schema.Literal("PASS"),
  evidenceStatus: EvidenceStatusSchema,
  path: Schema.String,
  sha256: Sha256Schema,
  description: Schema.String,
  source: Schema.optionalKey(Schema.String),
  sourceManifestSha256: Schema.optionalKey(Sha256Schema),
  sourceManifestPath: Schema.optionalKey(SourceManifestPathSchema),
});

const MissingArtifactSchema = Schema.Struct({
  id: Schema.String,
  kind: ArtifactKindSchema,
  artifactStatus: Schema.Literal("MISSING"),
  evidenceStatus: Schema.Literal("MISSING"),
  path: Schema.Null,
  sha256: Schema.Null,
  description: Schema.String,
  source: Schema.optionalKey(Schema.String),
});

export const DemoPacketIndexSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  packet: Schema.Literal("openpoke-v1-demo"),
  artifacts: Schema.Array(Schema.Union([PresentArtifactSchema, MissingArtifactSchema])),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export class DemoPacketVerificationError extends Data.TaggedError("DemoPacketVerificationError")<{
  readonly code: "INDEX_INVALID" | "ARTIFACT_INVALID";
  readonly message: string;
}> {}

const readIndex = (indexPath: string) =>
  Effect.tryPromise({
    try: () => readFile(indexPath, "utf8"),
    catch: () =>
      new DemoPacketVerificationError({
        code: "INDEX_INVALID",
        message: `cannot read index ${indexPath}`,
      }),
  }).pipe(
    Effect.andThen((text) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(DemoPacketIndexSchema))(text).pipe(
        Effect.mapError(
          () =>
            new DemoPacketVerificationError({
              code: "INDEX_INVALID",
              message: `cannot decode index ${indexPath}`,
            }),
        ),
      ),
    ),
  );

const verifyPresentArtifact = (
  packetRealPath: string,
  indexDirectory: string,
  artifact: typeof PresentArtifactSchema.Type,
) =>
  Effect.gen(function* () {
    if (isAbsolute(artifact.path)) {
      return yield* new DemoPacketVerificationError({
        code: "ARTIFACT_INVALID",
        message: `${artifact.id}: path must be relative`,
      });
    }

    const artifactPath = resolve(indexDirectory, artifact.path);
    const packetPrefix = `${packetRealPath}${sep}`;
    const artifactRealPath = yield* Effect.tryPromise({
      try: () => realpath(artifactPath),
      catch: () =>
        new DemoPacketVerificationError({
          code: "ARTIFACT_INVALID",
          message: `${artifact.id}: indexed artifact is missing`,
        }),
    });
    if (!artifactRealPath.startsWith(packetPrefix)) {
      return yield* new DemoPacketVerificationError({
        code: "ARTIFACT_INVALID",
        message: `${artifact.id}: path escapes packet directory`,
      });
    }

    const metadata = yield* Effect.tryPromise({
      try: () => lstat(artifactPath),
      catch: () =>
        new DemoPacketVerificationError({
          code: "ARTIFACT_INVALID",
          message: `${artifact.id}: indexed artifact is missing`,
        }),
    });
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return yield* new DemoPacketVerificationError({
        code: "ARTIFACT_INVALID",
        message: `${artifact.id}: artifact must be a regular file`,
      });
    }

    const bytes = yield* Effect.tryPromise({
      try: () => readFile(artifactRealPath),
      catch: () =>
        new DemoPacketVerificationError({
          code: "ARTIFACT_INVALID",
          message: `${artifact.id}: cannot read indexed artifact`,
        }),
    });
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== artifact.sha256) {
      return yield* new DemoPacketVerificationError({
        code: "ARTIFACT_INVALID",
        message: `${artifact.id}: checksum mismatch`,
      });
    }

    return bytes;
  });

const parseSourceManifest = (manifestId: string, bytes: Buffer) => {
  const text = bytes.toString("utf8");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const entries = lines.map((line) => {
    const match = /^([a-f0-9]{64})  (\.\/[^\r\n]+)$/u.exec(line);
    return match === null ? null : { sha256: match[1], path: match[2] };
  });

  return Schema.decodeUnknownEffect(Schema.Array(SourceManifestEntrySchema))(entries).pipe(
    Effect.mapError(
      () =>
        new DemoPacketVerificationError({
          code: "ARTIFACT_INVALID",
          message: `${manifestId}: malformed source manifest`,
        }),
    ),
  );
};

const verifyWalkthroughInspection = (artifactId: string, bytes: Buffer) => {
  const walkthrough = bytes.toString("utf8");
  if (/uninspected repository/iu.test(walkthrough)) {
    return Effect.fail(
      new DemoPacketVerificationError({
        code: "ARTIFACT_INVALID",
        message: `${artifactId}: superseded uninspected repository disclaimer`,
      }),
    );
  }
  if (!walkthrough.includes(InspectedOpenPokeRevisionReference)) {
    return Effect.fail(
      new DemoPacketVerificationError({
        code: "ARTIFACT_INVALID",
        message: `${artifactId}: inspected OpenPoke revision is missing or changed`,
      }),
    );
  }
  for (const [symbol, sourcePath] of OpenPokeSourceReferences) {
    const reference =
      `[${symbol}]` +
      `(https://github.com/shlokkhemani/openpoke/blob/${InspectedOpenPokeRevision}/${sourcePath})`;
    if (!walkthrough.includes(reference)) {
      return Effect.fail(
        new DemoPacketVerificationError({
          code: "ARTIFACT_INVALID",
          message: `${artifactId}: missing exact OpenPoke source reference ${symbol}`,
        }),
      );
    }
  }
  return Effect.void;
};

export const verifyDemoPacket = (indexPath: string) =>
  Effect.gen(function* () {
    const index = yield* readIndex(indexPath);
    const indexDirectory = dirname(resolve(indexPath));
    const packetRealPath = yield* Effect.tryPromise({
      try: () => realpath(indexDirectory),
      catch: () =>
        new DemoPacketVerificationError({
          code: "INDEX_INVALID",
          message: `cannot resolve packet directory ${indexDirectory}`,
        }),
    });
    const artifactIds = new Set<string>();
    for (const artifact of index.artifacts) {
      if (artifactIds.has(artifact.id)) {
        return yield* new DemoPacketVerificationError({
          code: "INDEX_INVALID",
          message: `duplicate artifact id ${artifact.id}`,
        });
      }
      artifactIds.add(artifact.id);
    }
    const walkthroughArtifact = index.artifacts.find(
      (artifact) => artifact.id === "three-part-walkthrough",
    );
    if (
      walkthroughArtifact === undefined ||
      walkthroughArtifact.artifactStatus !== "PASS" ||
      walkthroughArtifact.kind !== "document" ||
      walkthroughArtifact.path !== "walkthrough.md"
    ) {
      return yield* new DemoPacketVerificationError({
        code: "INDEX_INVALID",
        message: "required three-part-walkthrough artifact is missing or invalid",
      });
    }
    const present = index.artifacts.filter((artifact) => artifact.artifactStatus === "PASS");
    const missing = index.artifacts.length - present.length;
    for (const artifact of present) {
      const hasManifestChecksum = artifact.sourceManifestSha256 !== undefined;
      const hasManifestPath = artifact.sourceManifestPath !== undefined;
      if (hasManifestChecksum !== hasManifestPath) {
        return yield* new DemoPacketVerificationError({
          code: "INDEX_INVALID",
          message: `${artifact.id}: source manifest checksum and path must be paired`,
        });
      }
    }

    const verified = yield* Effect.forEach(
      present,
      (artifact) =>
        verifyPresentArtifact(packetRealPath, indexDirectory, artifact).pipe(
          Effect.map((bytes) => ({ artifact, bytes })),
        ),
      { concurrency: 1 },
    );

    for (const { artifact, bytes } of verified) {
      if (artifact.id === "three-part-walkthrough") {
        yield* verifyWalkthroughInspection(artifact.id, bytes);
      }
    }

    for (const { artifact } of verified) {
      if (
        artifact.sourceManifestSha256 === undefined ||
        artifact.sourceManifestPath === undefined
      ) {
        continue;
      }
      const manifest = verified.find(
        (candidate) =>
          candidate.artifact.kind === "source-manifest" &&
          candidate.artifact.sha256 === artifact.sourceManifestSha256,
      );
      if (manifest === undefined) {
        return yield* new DemoPacketVerificationError({
          code: "INDEX_INVALID",
          message: `${artifact.id}: source manifest checksum is not indexed`,
        });
      }
      const entries = yield* parseSourceManifest(manifest.artifact.id, manifest.bytes);
      if (
        !entries.some(
          (entry) => entry.path === artifact.sourceManifestPath && entry.sha256 === artifact.sha256,
        )
      ) {
        return yield* new DemoPacketVerificationError({
          code: "ARTIFACT_INVALID",
          message: `${artifact.id}: source manifest entry mismatch`,
        });
      }
    }

    return { present: present.length, missing } as const;
  });

const indexArguments = process.argv.slice(2);
const indexPath = indexArguments.length === 1 ? indexArguments[0] : undefined;
const verification =
  indexPath === undefined
    ? Effect.fail(
        new DemoPacketVerificationError({
          code: "INDEX_INVALID",
          message: "expected one artifact index path",
        }),
      )
    : verifyDemoPacket(indexPath);

const program = verification.pipe(
  Effect.tap(({ present, missing }) =>
    Effect.sync(() => {
      const noun = present === 1 ? "artifact" : "artifacts";
      process.stdout.write(`PASS: verified ${present} ${noun}; ${missing} MISSING\n`);
    }),
  ),
  Effect.catch((error) =>
    Effect.sync(() => {
      process.stderr.write(`FAIL: ${error.code}: ${error.message}\n`);
      process.exitCode = 1;
    }),
  ),
);

NodeRuntime.runMain(program);
