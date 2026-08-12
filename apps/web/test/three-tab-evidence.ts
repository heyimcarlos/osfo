import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Data, Effect, Fiber, Option, Predicate, Ref, Schema, Scope } from "effect";

const IsoTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
);
const TabLabelSchema = Schema.Literals(["A", "B", "C"]);
const JourneyStepSchema = Schema.Literals([
  "initial-synchronized",
  "tab-b-disconnected",
  "first-message-completed",
  "tab-b-resumed-from-own-cursor",
  "tab-c-disconnected",
  "second-message-completed",
  "tab-c-resumed-from-own-cursor",
  "tab-a-disconnected",
  "third-message-completed",
  "tab-a-resumed-from-own-cursor",
  "all-projections-reconciled",
]);
const ThreeTabJourneyEventSchema = Schema.Struct({
  step: JourneyStepSchema,
  at: IsoTimestampSchema,
  frame: Schema.Number,
  tab: Schema.optionalKey(TabLabelSchema),
  fromPosition: Schema.optionalKey(Schema.String),
  toPosition: Schema.optionalKey(Schema.String),
});

export const THREE_TAB_PROOF_SCOPE =
  "authenticated independent observer-tab disconnect and cursor resume; sender-close-mid-response is not exercised" as const;

export const ThreeTabJourneySchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  proofScope: Schema.Literal(THREE_TAB_PROOF_SCOPE),
  framesPerSecond: Schema.Literal(4),
  viewport: Schema.Struct({ width: Schema.Literal(640), height: Schema.Literal(960) }),
  startedAt: IsoTimestampSchema,
  endedAt: IsoTimestampSchema,
  events: Schema.Array(ThreeTabJourneyEventSchema),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

type JourneyStep = typeof JourneyStepSchema.Type;
type TabLabel = typeof TabLabelSchema.Type;

interface CapturableTab {
  readonly label: string;
  readonly configureEvidenceViewport: (
    width: number,
    height: number,
  ) => Effect.Effect<void, unknown, never>;
  readonly captureEvidenceFrame: () => Effect.Effect<Buffer, unknown, never>;
}

const CapturableTabBoundarySchema = Schema.Array(
  Schema.Struct({
    label: TabLabelSchema,
    configureEvidenceViewport: Schema.declare(Predicate.isFunction),
    captureEvidenceFrame: Schema.declare(Predicate.isFunction),
  }),
);
const isCapturableTabBoundary = Schema.is(CapturableTabBoundarySchema);
const hasCapturableTabBoundary = (tabs: ReadonlyArray<CapturableTab>): boolean =>
  isCapturableTabBoundary(tabs);

interface JourneyEventDetails {
  readonly tab?: TabLabel;
  readonly fromPosition?: string;
  readonly toPosition?: string;
}

interface ThreeTabEvidenceCapture {
  readonly enabled: boolean;
  readonly mark: (
    step: JourneyStep,
    details: JourneyEventDetails,
  ) => Effect.Effect<void, never, never>;
  readonly stop: Effect.Effect<void, ThreeTabEvidenceError, never>;
}

export class ThreeTabEvidenceError extends Data.TaggedError("ThreeTabEvidenceError")<{
  readonly operation: string;
  readonly cause?: unknown;
}> {}

const noOpCapture = {
  enabled: false as const,
  mark: (_step: JourneyStep, _details: JourneyEventDetails) => Effect.void,
  stop: Effect.void,
};

const writeFrame = (path: string, bytes: Buffer) =>
  Effect.tryPromise({
    try: () => writeFile(path, bytes),
    catch: (cause) => new ThreeTabEvidenceError({ operation: `write frame ${path}`, cause }),
  });

export const startThreeTabEvidenceCapture = (input: {
  readonly directory: string | undefined;
  readonly tabs: ReadonlyArray<CapturableTab>;
}): Effect.Effect<ThreeTabEvidenceCapture, ThreeTabEvidenceError, Scope.Scope> => {
  const directory = input.directory;
  if (directory === undefined) return Effect.succeed(noOpCapture);

  return Effect.gen(function* () {
    const tabs = input.tabs;
    if (!hasCapturableTabBoundary(tabs) || new Set(tabs.map((tab) => tab.label)).size !== 3) {
      return yield* new ThreeTabEvidenceError({ operation: "require distinct tabs A, B, and C" });
    }
    const framesDirectory = join(directory, "frames");
    yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          mkdir(join(framesDirectory, "A"), { recursive: true }),
          mkdir(join(framesDirectory, "B"), { recursive: true }),
          mkdir(join(framesDirectory, "C"), { recursive: true }),
        ]),
      catch: (cause) =>
        new ThreeTabEvidenceError({ operation: "create three-tab frame directories", cause }),
    });
    yield* Effect.forEach(
      tabs,
      (tab) =>
        tab.configureEvidenceViewport(640, 960).pipe(
          Effect.mapError(
            (cause) =>
              new ThreeTabEvidenceError({
                operation: `configure evidence viewport for tab ${tab.label}`,
                cause,
              }),
          ),
        ),
      { concurrency: "unbounded" },
    );

    const frame = yield* Ref.make(0);
    const events = yield* Ref.make<ReadonlyArray<typeof ThreeTabJourneyEventSchema.Type>>([]);
    const failure = yield* Ref.make<Option.Option<ThreeTabEvidenceError>>(Option.none());
    const startedAt = new Date().toISOString();
    const captureTick = Effect.gen(function* () {
      const current = yield* Ref.get(frame);
      const fileName = `${String(current).padStart(6, "0")}.png`;
      const screenshots = yield* Effect.forEach(
        tabs,
        (tab) =>
          tab.captureEvidenceFrame().pipe(
            Effect.mapError(
              (cause) =>
                new ThreeTabEvidenceError({
                  operation: `capture evidence frame for tab ${tab.label}`,
                  cause,
                }),
            ),
            Effect.map((bytes) => ({ label: tab.label, bytes })),
          ),
        { concurrency: "unbounded" },
      );
      yield* Effect.forEach(
        screenshots,
        ({ bytes, label }) => writeFrame(join(framesDirectory, label, fileName), bytes),
        { concurrency: "unbounded" },
      );
      yield* Ref.set(frame, current + 1);
    });
    const loop = captureTick.pipe(
      Effect.andThen(Effect.sleep(250)),
      Effect.forever,
      Effect.catch((cause) => Ref.set(failure, Option.some(cause))),
    );
    const fiber = yield* Effect.forkScoped(loop);

    const mark = (step: JourneyStep, details: JourneyEventDetails) =>
      Effect.gen(function* () {
        const currentFrame = yield* Ref.get(frame);
        let event: typeof ThreeTabJourneyEventSchema.Type = {
          step,
          at: new Date().toISOString(),
          frame: currentFrame,
        };
        if (details.tab !== undefined) event = { ...event, tab: details.tab };
        if (details.fromPosition !== undefined)
          event = { ...event, fromPosition: details.fromPosition };
        if (details.toPosition !== undefined) event = { ...event, toPosition: details.toPosition };
        yield* Ref.update(events, (current) => [...current, event]);
        yield* Effect.sleep(500);
      });

    const stop = Effect.gen(function* () {
      yield* Fiber.interrupt(fiber);
      const captureFailure = yield* Ref.get(failure);
      if (Option.isSome(captureFailure)) return yield* captureFailure.value;
      yield* captureTick;
      const journey = {
        schemaVersion: 1 as const,
        proofScope: THREE_TAB_PROOF_SCOPE,
        framesPerSecond: 4 as const,
        viewport: { width: 640 as const, height: 960 as const },
        startedAt,
        endedAt: new Date().toISOString(),
        events: yield* Ref.get(events),
      };
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ThreeTabJourneySchema))(
        journey,
      ).pipe(
        Effect.mapError(
          (cause) => new ThreeTabEvidenceError({ operation: "encode journey.json", cause }),
        ),
      );
      yield* Effect.tryPromise({
        try: () => writeFile(join(directory, "journey.json"), `${encoded}\n`),
        catch: (cause) =>
          new ThreeTabEvidenceError({ operation: "write semantic journey.json", cause }),
      });
    });

    return { enabled: true as const, mark, stop };
  });
};
