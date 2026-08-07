import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Data, Effect, Schema } from "effect";

import {
  buildDeliveryCardModel,
  buildMatrixCardModel,
  buildReceiptCardModel,
  buildWorkerLossCardModel,
  renderCardHtml,
  type EvidenceCardModel,
} from "./demo-evidence-card.js";

const execFileAsync = promisify(execFile);
const observabilityDirectory = dirname(fileURLToPath(import.meta.url));
const verifierPath = join(observabilityDirectory, "demo-packet-verifier.ts");

const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const IndexedArtifactSchema = Schema.Struct({
  id: Schema.String,
  artifactStatus: Schema.Literals(["PASS", "MISSING"]),
  path: Schema.NullOr(Schema.String),
  sha256: Schema.NullOr(Sha256Schema),
  sourceManifestSha256: Schema.optionalKey(Sha256Schema),
});
const CardPacketIndexSchema = Schema.Struct({
  packet: Schema.Literal("openpoke-v1-demo"),
  artifacts: Schema.Array(IndexedArtifactSchema),
});
const ReceiptSloFileSchema = Schema.Struct({
  runs: Schema.Array(
    Schema.Struct({
      run: Schema.String,
      total: Schema.Number,
      over_threshold: Schema.Number,
      within_threshold_ratio: Schema.Number,
      source_manifest_sha256: Sha256Schema,
    }),
  ),
});

export class EvidenceCardRendererError extends Data.TaggedError("EvidenceCardRendererError")<{
  readonly operation: string;
}> {}

const runCommand = (command: string, arguments_: ReadonlyArray<string>, operation: string) =>
  Effect.tryPromise({
    try: () => execFileAsync(command, arguments_, { maxBuffer: 8 * 1024 * 1024 }),
    catch: () => new EvidenceCardRendererError({ operation }),
  });

const verifyPacketFirst = (indexPath: string) =>
  runCommand("bun", [verifierPath, indexPath], "packet verification preflight failed");

const readJson = (path: string, operation: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: () => new EvidenceCardRendererError({ operation }),
  }).pipe(
    Effect.andThen((text) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
        Effect.mapError(() => new EvidenceCardRendererError({ operation })),
      ),
    ),
  );

const decodeJsonBytes = (bytes: Buffer, operation: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(bytes.toString("utf8")).pipe(
    Effect.mapError(() => new EvidenceCardRendererError({ operation })),
  );

const decodeIndex = (indexPath: string) =>
  readJson(indexPath, "read verified packet index").pipe(
    Effect.andThen(Schema.decodeUnknownEffect(CardPacketIndexSchema)),
    Effect.mapError(
      () => new EvidenceCardRendererError({ operation: "decode verified packet index" }),
    ),
  );

type CardPacketIndex = typeof CardPacketIndexSchema.Type;
type RequiredArtifact = {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly sourceManifestSha256: string | undefined;
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const requireArtifact = (index: CardPacketIndex, id: string) =>
  Effect.gen(function* () {
    const artifact = index.artifacts.find((candidate) => candidate.id === id);
    if (
      artifact === undefined ||
      artifact.artifactStatus !== "PASS" ||
      artifact.path === null ||
      artifact.sha256 === null
    ) {
      return yield* new EvidenceCardRendererError({
        operation: `require packet artifact ${id}`,
      });
    }
    return {
      id: artifact.id,
      path: artifact.path,
      sha256: artifact.sha256,
      sourceManifestSha256: artifact.sourceManifestSha256,
    };
  });

const readVerifiedArtifactBytes = (packetDirectory: string, artifact: RequiredArtifact) =>
  Effect.gen(function* () {
    if (isAbsolute(artifact.path)) {
      return yield* new EvidenceCardRendererError({
        operation: `reject absolute packet artifact path ${artifact.id}`,
      });
    }
    const packetRealPath = yield* Effect.tryPromise({
      try: () => realpath(packetDirectory),
      catch: () => new EvidenceCardRendererError({ operation: "resolve packet directory" }),
    });
    const artifactRealPath = yield* Effect.tryPromise({
      try: () => realpath(resolve(packetDirectory, artifact.path)),
      catch: () =>
        new EvidenceCardRendererError({ operation: `resolve packet artifact ${artifact.id}` }),
    });
    if (!artifactRealPath.startsWith(`${packetRealPath}${sep}`)) {
      return yield* new EvidenceCardRendererError({
        operation: `reject packet artifact escape ${artifact.id}`,
      });
    }

    const bytes = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(artifactRealPath, constants.O_RDONLY | constants.O_NOFOLLOW),
        catch: () =>
          new EvidenceCardRendererError({ operation: `open packet artifact ${artifact.id}` }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const metadata = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: () =>
              new EvidenceCardRendererError({ operation: `stat packet artifact ${artifact.id}` }),
          });
          if (!metadata.isFile()) {
            return yield* new EvidenceCardRendererError({
              operation: `require regular packet artifact ${artifact.id}`,
            });
          }
          return yield* Effect.tryPromise({
            try: () => handle.readFile(),
            catch: () =>
              new EvidenceCardRendererError({ operation: `read packet artifact ${artifact.id}` }),
          });
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: () =>
            new EvidenceCardRendererError({ operation: `close packet artifact ${artifact.id}` }),
        }).pipe(Effect.ignore),
    );
    if (sha256(bytes) !== artifact.sha256) {
      return yield* new EvidenceCardRendererError({
        operation: `match packet artifact checksum ${artifact.id}`,
      });
    }
    return bytes;
  });

const readArtifactJson = (packetDirectory: string, index: CardPacketIndex, id: string) =>
  requireArtifact(index, id).pipe(
    Effect.andThen((artifact) => readVerifiedArtifactBytes(packetDirectory, artifact)),
    Effect.andThen((bytes) => decodeJsonBytes(bytes, `decode packet artifact ${id}`)),
  );

const requireSourceManifestSha = (index: CardPacketIndex, scenarioId: string) =>
  requireArtifact(index, scenarioId).pipe(
    Effect.andThen((artifact) =>
      artifact.sourceManifestSha256 === undefined
        ? Effect.fail(
            new EvidenceCardRendererError({
              operation: `require source manifest for ${scenarioId}`,
            }),
          )
        : Effect.succeed(artifact.sourceManifestSha256),
    ),
  );

const readReceiptSloRun = (packetDirectory: string, index: CardPacketIndex, run: string) =>
  readArtifactJson(packetDirectory, index, "receipt-slo-derivation").pipe(
    Effect.andThen(Schema.decodeUnknownEffect(ReceiptSloFileSchema)),
    Effect.mapError(
      () => new EvidenceCardRendererError({ operation: "decode receipt SLO derivation" }),
    ),
    Effect.andThen((file) => {
      const candidate = file.runs.find((value) => value.run === run);
      return candidate === undefined
        ? Effect.fail(new EvidenceCardRendererError({ operation: `find receipt SLO run ${run}` }))
        : Effect.succeed(candidate);
    }),
  );

const matrixCards = (packetDirectory: string, index: CardPacketIndex) =>
  Effect.gen(function* () {
    const summary = yield* readArtifactJson(
      packetDirectory,
      index,
      "final-issue-87-matrix-summary",
    );
    return yield* Effect.forEach(["A", "B", "C", "D"] as const, (cell) => {
      const scenarioId = `matrix-${cell.toLowerCase()}-scenario`;
      return Effect.gen(function* () {
        const scenario = yield* readArtifactJson(packetDirectory, index, scenarioId);
        const sourceManifestSha256 = yield* requireSourceManifestSha(index, scenarioId);
        return yield* buildMatrixCardModel({
          cell,
          scenario,
          sourceManifestSha256,
          summary,
        });
      });
    });
  });

const receiptCard = (
  packetDirectory: string,
  index: CardPacketIndex,
  definition: {
    readonly id: string;
    readonly title: string;
    readonly artifactPrefix: string;
    readonly receiptSloRun?: string;
  },
) =>
  Effect.gen(function* () {
    const scenarioId = `${definition.artifactPrefix}-scenario`;
    const scenario = yield* readArtifactJson(packetDirectory, index, scenarioId);
    const audit = yield* readArtifactJson(
      packetDirectory,
      index,
      `${definition.artifactPrefix}-audit`,
    );
    const callerSummary = yield* readArtifactJson(
      packetDirectory,
      index,
      `${definition.artifactPrefix}-caller-summary`,
    );
    const sourceManifestSha256 = yield* requireSourceManifestSha(index, scenarioId);
    const receiptSlo =
      definition.receiptSloRun === undefined
        ? undefined
        : yield* readReceiptSloRun(packetDirectory, index, definition.receiptSloRun);
    return yield* buildReceiptCardModel({
      id: definition.id,
      title: definition.title,
      scenario,
      audit,
      callerSummary,
      receiptSlo,
      sourceManifestSha256,
    });
  });

const deliveryCard = (
  packetDirectory: string,
  index: CardPacketIndex,
  definition: { readonly id: string; readonly title: string; readonly artifactPrefix: string },
) =>
  Effect.gen(function* () {
    const scenarioId = `${definition.artifactPrefix}-scenario`;
    const sourceManifestSha256 = yield* requireSourceManifestSha(index, scenarioId);
    return yield* buildDeliveryCardModel({
      id: definition.id,
      title: definition.title,
      sourceManifestSha256,
      scenario: yield* readArtifactJson(packetDirectory, index, scenarioId),
      audit: yield* readArtifactJson(packetDirectory, index, `${definition.artifactPrefix}-audit`),
    });
  });

const workerLossCard = (
  packetDirectory: string,
  index: CardPacketIndex,
  phase: "before-claim" | "after-claim",
) =>
  Effect.gen(function* () {
    const prefix = phase === "before-claim" ? "worker-loss-before" : "worker-loss-after";
    const scenarioId = `${prefix}-scenario`;
    return yield* buildWorkerLossCardModel({
      phase,
      sourceManifestSha256: yield* requireSourceManifestSha(index, scenarioId),
      scenario: yield* readArtifactJson(packetDirectory, index, scenarioId),
      audit: yield* readArtifactJson(packetDirectory, index, `${prefix}-audit`),
    });
  });

const buildCards = (packetDirectory: string, index: CardPacketIndex) =>
  Effect.gen(function* () {
    const matrices = yield* matrixCards(packetDirectory, index);
    const receipts = yield* Effect.forEach(
      [
        {
          id: "short-target",
          title: "Short selected-topology target",
          artifactPrefix: "short-target",
        },
        {
          id: "sustained-rep1",
          title: "Sustained target, repetition 1",
          artifactPrefix: "sustained-rep1",
          receiptSloRun: "sustained-target-232-rep1",
        },
        {
          id: "sustained-rep2",
          title: "Sustained target, repetition 2",
          artifactPrefix: "sustained-rep2",
          receiptSloRun: "sustained-target-232-rep2",
        },
      ],
      (definition) => receiptCard(packetDirectory, index, definition),
    );
    const deliveries = yield* Effect.forEach(
      [
        {
          id: "pre-admitted",
          title: "Pre-admitted delivery control",
          artifactPrefix: "pre-admitted",
        },
        {
          id: "recovery-4",
          title: "Recovery-rate screen, four workers",
          artifactPrefix: "recovery-4",
        },
        {
          id: "recovery-6",
          title: "Recovery-rate screen, six workers",
          artifactPrefix: "recovery-6",
        },
        {
          id: "recovery-8",
          title: "Recovery-rate screen, eight workers",
          artifactPrefix: "recovery-8",
        },
      ],
      (definition) => deliveryCard(packetDirectory, index, definition),
    );
    const losses = yield* Effect.all([
      workerLossCard(packetDirectory, index, "before-claim"),
      workerLossCard(packetDirectory, index, "after-claim"),
    ]);
    return [...matrices, ...receipts, ...deliveries, ...losses];
  });

const findChromium = Effect.gen(function* () {
  for (const candidate of [
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ]) {
    const exists = yield* Effect.tryPromise({
      try: () => access(candidate).then(() => true),
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (exists) return candidate;
  }
  return yield* new EvidenceCardRendererError({ operation: "find Chromium" });
});

const requireArtifactAtPath = (index: CardPacketIndex, path: string) =>
  Effect.gen(function* () {
    const artifact = index.artifacts.find(
      (candidate) => candidate.artifactStatus === "PASS" && candidate.path === path,
    );
    if (artifact === undefined || artifact.sha256 === null) {
      return yield* new EvidenceCardRendererError({
        operation: `require indexed output ${path}`,
      });
    }
    return artifact;
  });

const requireIndexedDigest = (index: CardPacketIndex, path: string, bytes: Buffer) =>
  requireArtifactAtPath(index, path).pipe(
    Effect.andThen((artifact) =>
      sha256(bytes) === artifact.sha256
        ? Effect.void
        : Effect.fail(
            new EvidenceCardRendererError({
              operation: `match reproduced output checksum ${path}`,
            }),
          ),
    ),
  );

const renderCards = (index: CardPacketIndex, cards: ReadonlyArray<EvidenceCardModel>) =>
  Effect.gen(function* () {
    const temporaryDirectory = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "osfo-post-run-cards-")),
      catch: () => new EvidenceCardRendererError({ operation: "create card staging directory" }),
    });
    const outputDirectory = join(temporaryDirectory, "post-run");
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        try: () => rm(temporaryDirectory, { recursive: true, force: true }),
        catch: () => new EvidenceCardRendererError({ operation: "remove card staging directory" }),
      }).pipe(Effect.ignore),
    );
    yield* Effect.tryPromise({
      try: () => mkdir(outputDirectory, { recursive: true }),
      catch: () => new EvidenceCardRendererError({ operation: "create staged card directory" }),
    });
    const chromium = yield* findChromium;
    for (const card of cards) {
      const htmlPath = join(temporaryDirectory, `${card.id}.html`);
      const pngPath = join(outputDirectory, `${card.id}.png`);
      yield* Effect.tryPromise({
        try: () => writeFile(htmlPath, renderCardHtml(card)),
        catch: () => new EvidenceCardRendererError({ operation: `write ${card.id} card HTML` }),
      });
      yield* runCommand(
        chromium,
        [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--hide-scrollbars",
          "--force-device-scale-factor=1",
          "--window-size=1600,900",
          `--screenshot=${pngPath}`,
          pathToFileURL(htmlPath).href,
        ],
        `render ${card.id} with Chromium`,
      );
    }
    const renderedCards = yield* Effect.forEach(cards, (card) =>
      Effect.tryPromise({
        try: () => readFile(join(outputDirectory, `${card.id}.png`)),
        catch: () => new EvidenceCardRendererError({ operation: `read rendered ${card.id}` }),
      }).pipe(Effect.map((bytes) => ({ card, bytes }))),
    );
    const manifestBytes = Buffer.from(
      `${renderedCards
        .map(({ card, bytes }) => `${sha256(bytes)}  ./${card.id}.png`)
        .join("\n")}\n`,
    );
    yield* Effect.tryPromise({
      try: () => writeFile(join(outputDirectory, "POST-RUN-CARDS-SHA256SUMS"), manifestBytes),
      catch: () => new EvidenceCardRendererError({ operation: "seal rendered cards" }),
    });
    yield* Effect.forEach(renderedCards, ({ card, bytes }) =>
      requireIndexedDigest(index, `assets/post-run/${card.id}.png`, bytes),
    );
    yield* requireIndexedDigest(index, "assets/post-run/POST-RUN-CARDS-SHA256SUMS", manifestBytes);
  }).pipe(Effect.scoped);

const arguments_ = process.argv.slice(2);
const indexPath = arguments_.length === 1 ? resolve(arguments_[0]!) : undefined;
const program =
  indexPath === undefined
    ? Effect.fail(new EvidenceCardRendererError({ operation: "expected one packet index path" }))
    : Effect.gen(function* () {
        yield* verifyPacketFirst(indexPath);
        const index = yield* decodeIndex(indexPath);
        const packetDirectory = dirname(indexPath);
        const cards = yield* buildCards(packetDirectory, index);
        yield* renderCards(index, cards);
        yield* verifyPacketFirst(indexPath);
        yield* Effect.sync(() =>
          process.stdout.write(
            `PASS: reproduced ${cards.length} post-run cards in staging; all bytes match the indexed packet\n`,
          ),
        );
      });

NodeRuntime.runMain(
  program.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        process.stderr.write(`FAIL: ${error.operation}\n`);
        process.exitCode = 1;
      }),
    ),
  ),
);
