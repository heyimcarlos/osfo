import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { NodeRuntime } from "@effect/platform-node";
import { Data, Effect, Schema } from "effect";

const EvidenceStatusSchema = Schema.Literals(["PASS", "FAIL", "MISSING"]);
const ArtifactKindSchema = Schema.Literals([
  "sealed-run",
  "dashboard-view",
  "recording",
  "document",
]);
const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

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
    const rootPrefix = `${resolve(indexDirectory)}${sep}`;
    if (!artifactPath.startsWith(rootPrefix)) {
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
      try: () => readFile(artifactPath),
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
  });

export const verifyDemoPacket = (indexPath: string) =>
  Effect.gen(function* () {
    const index = yield* readIndex(indexPath);
    const indexDirectory = dirname(resolve(indexPath));
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
    const present = index.artifacts.filter((artifact) => artifact.artifactStatus === "PASS");
    const missing = index.artifacts.length - present.length;
    const indexedChecksums = new Set(present.map((artifact) => artifact.sha256));
    for (const artifact of present) {
      if (
        artifact.sourceManifestSha256 !== undefined &&
        !indexedChecksums.has(artifact.sourceManifestSha256)
      ) {
        return yield* new DemoPacketVerificationError({
          code: "INDEX_INVALID",
          message: `${artifact.id}: source manifest checksum is not indexed`,
        });
      }
    }

    yield* Effect.forEach(present, (artifact) => verifyPresentArtifact(indexDirectory, artifact), {
      concurrency: 1,
      discard: true,
    });

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
