/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect tests. */
import type { MessengerContext } from "@cloudflare/think/messengers";
import { expect, it } from "@effect/vitest";
import type { UIMessage } from "ai";
import { Effect, Predicate, Schema } from "effect";

import { ThinkSubmissionId, UserId } from "../../domain";
import { FileRecord } from "../../domain/file";
import { MessengerAttachments } from "../../integrations/messenger-attachments";
import { FileContentUnavailable } from "../../services/files";
import { MessengerFileIngress } from "./messenger-file-ingress";

const context: MessengerContext = {
  capabilities: {},
  kind: "direct-message",
  provider: "telegram",
  messengerId: "telegram-main",
  thread: { id: "direct:1", providerThreadId: "1", isDirectMessage: true },
  message: {
    id: "message-1",
    providerMessageId: "1",
    author: { userId: "sender-1" },
    text: "Read the attached PDF; give its reference and unknown birth date.",
    attachments: [{ mediaType: "application/pdf", fetchMetadata: { fileId: "provider-file-1" } }],
  },
};

const input: MessengerFileIngress.Input = {
  context,
  submissionId: ThinkSubmissionId.make("messenger-submission-1"),
  userId: UserId.make("user-1"),
  userMessage: {
    id: "message-1",
    role: "user",
    parts: [
      { type: "text", text: "Read the attached PDF" },
      { type: "file", mediaType: "application/pdf", url: "https://untrusted.invalid/file" },
    ],
  },
};

const harness = (authorized = true) => {
  const uploads: Array<
    Parameters<MessengerFileIngress.Dependencies<never, never, FileContentUnavailable>["upload"]>[0]
  > = [];
  const downloads: Array<MessengerAttachments.DownloadInput> = [];
  const dependencies: MessengerFileIngress.Dependencies<never, never, FileContentUnavailable> = {
    authorize: Effect.succeed(authorized),
    read: ({ fileId }) => new FileContentUnavailable({ fileId, message: "No retained file" }),
    download: (request) =>
      Effect.sync(() => {
        downloads.push(request);
        return {
          bytes: new TextEncoder().encode("%PDF-synthetic"),
          mediaType: "application/pdf",
          name: undefined,
        };
      }),
    upload: (request) =>
      Effect.sync(() => {
        uploads.push(request);
        return {
          _tag: "FileReady",
          file: readyFile({
            ...request,
            acceptedAt: "2026-09-05T00:00:00.000Z",
            allowancePeriodId: "period-1",
            byteLength: BigInt(request.bytes.byteLength),
            mediaType: request.declaredMediaType,
            objectKey: `owned/${request.fileId}`,
            sha256: `sha256:${"a".repeat(64)}`,
            userId: input.userId,
            deletedAt: null,
            normalizationError: null,
            normalizationClaimedAt: null,
            normalizedText: "[Page 1 — ocr]\nReference: SAMPLE-4821",
            provenanceJson: "{}",
            state: "ready",
          }),
        };
      }),
  };
  return { uploads, downloads, dependencies };
};

it.effect(
  "ingests authorized media with stable owned identities and removes raw model media URLs",
  () =>
    Effect.gen(function* () {
      const test = harness();
      const first = yield* MessengerFileIngress.ingest(input, test.dependencies);
      const replay = yield* MessengerFileIngress.ingest(input, test.dependencies);
      expect(first).toEqual(replay);
      expect(test.uploads).toHaveLength(2);
      expect(test.uploads[0]).toEqual(test.uploads[1]);
      expect(test.uploads[0]?.fileId).toMatch(/^messenger-file-[a-f0-9]{64}$/u);
      expect(test.uploads[0]?.fileName).toBe("attachment-1.pdf");
      if (Predicate.isString(first)) throw new Error("Expected UI message");
      expect(first.id).toBe("message-1");
      expect(first.parts.some((part) => part.type === "file")).toBe(false);
      expect(first.parts).toContainEqual({ type: "text", text: "Read the attached PDF" });
      expect(messageText(first)).toContain("Read it with readFile");
      expect(messageText(first)).not.toContain("untrusted.invalid");
    }),
);

it.effect("separates upload identities by owner and message", () =>
  Effect.gen(function* () {
    const test = harness();
    yield* MessengerFileIngress.ingest(input, test.dependencies);
    yield* MessengerFileIngress.ingest(
      { ...input, userId: UserId.make("user-2") },
      test.dependencies,
    );
    yield* MessengerFileIngress.ingest(
      { ...input, submissionId: ThinkSubmissionId.make("message-2") },
      test.dependencies,
    );
    expect(new Set(test.uploads.map((upload) => upload.fileId)).size).toBe(3);
  }),
);

it.effect("reuses an authorized ready File when provider media is unavailable on retry", () =>
  Effect.gen(function* () {
    const test = harness();
    const first = yield* MessengerFileIngress.ingest(input, test.dependencies);
    const request = test.uploads[0];
    if (request === undefined) throw new Error("Expected retained upload");
    const stored = yield* test.dependencies.upload(request);
    if (!Predicate.isTagged(stored, "FileReady")) throw new Error("Expected ready file");
    const file = stored.file;
    if (file.state !== "ready") throw new Error("Expected ready file state");
    const replay = yield* MessengerFileIngress.ingest(input, {
      ...test.dependencies,
      read: () => Effect.succeed({ _tag: "FileRead", bytes: request.bytes, file }),
      download: () => Effect.die(new Error("Retained files must not be downloaded again")),
      upload: () => Effect.die(new Error("Retained files must not be uploaded again")),
    });
    expect(replay).toEqual(first);
    expect(test.downloads).toHaveLength(1);
  }),
);

it.effect("does not download when Files denies access to a retained identity", () =>
  Effect.gen(function* () {
    const test = harness();
    const result = yield* MessengerFileIngress.ingest(input, {
      ...test.dependencies,
      read: () => Effect.succeed({ _tag: "Denied", reason: "ownershipRequired", resetAt: null }),
    });
    expect(test.downloads).toEqual([]);
    expect(test.uploads).toEqual([]);
    expect(messageText(result)).toContain("file access was denied");
  }),
);

it.effect.each(["stored", "normalizing"] as const)(
  "resumes %s source bytes without downloading provider media again",
  (state) =>
    Effect.gen(function* () {
      const test = harness();
      yield* MessengerFileIngress.ingest(input, test.dependencies);
      const request = test.uploads[0];
      if (request === undefined) throw new Error("Expected upload");
      const result = yield* test.dependencies.upload(request);
      if (!Predicate.isTagged(result, "FileReady") || result.file.state !== "ready")
        throw new Error("Expected ready fixture");
      const file = {
        ...result.file,
        ...(state === "normalizing"
          ? { state, normalizationClaimedAt: result.file.acceptedAt }
          : { state, normalizationClaimedAt: null }),
        normalizedText: null,
        provenanceJson: null,
      };
      const replay = yield* MessengerFileIngress.ingest(input, {
        ...test.dependencies,
        read: () => Effect.succeed({ _tag: "FileRead", bytes: request.bytes, file }),
        download: () => Effect.die(new Error("Stored source must not be downloaded again")),
      });
      expect(messageText(replay)).toContain("is ready");
      expect(test.downloads).toHaveLength(1);
      expect(test.uploads).toHaveLength(3);
    }),
);

it.effect("counts retained ready bytes toward the message budget on replay", () =>
  Effect.gen(function* () {
    const test = harness();
    yield* MessengerFileIngress.ingest(input, test.dependencies);
    const request = test.uploads[0];
    if (request === undefined || context.message === undefined)
      throw new Error("Expected upload fixture");
    const result = yield* test.dependencies.upload(request);
    if (!Predicate.isTagged(result, "FileReady") || result.file.state !== "ready")
      throw new Error("Expected ready fixture");
    const file = { ...result.file, byteLength: 9_000_000n };
    let reads = 0;
    const budgets: Array<number> = [];
    const replay = yield* MessengerFileIngress.ingest(
      {
        ...input,
        context: {
          ...context,
          message: {
            ...context.message,
            attachments: [
              ...context.message.attachments,
              { mediaType: "application/pdf", fetchMetadata: { fileId: "second" } },
            ],
          },
        },
      },
      {
        ...test.dependencies,
        read: ({ fileId }) =>
          ++reads === 1
            ? Effect.succeed({ _tag: "FileRead", bytes: new Uint8Array(9_000_000), file })
            : new FileContentUnavailable({ fileId, message: "No retained file" }),
        download: (downloadInput) =>
          Effect.sync(() => {
            budgets.push(downloadInput.maximumBytes);
            return {
              bytes: new Uint8Array(2_000_000),
              mediaType: "application/pdf",
              name: undefined,
            };
          }),
        upload: () => Effect.die(new Error("An over-budget file must not be uploaded")),
      },
    );
    expect(budgets).toEqual([1_000_000]);
    expect(messageText(replay)).toContain("outside the supported media or message size limit");
  }),
);

it.effect("performs no provider or File work after authorization is revoked", () =>
  Effect.gen(function* () {
    const test = harness(false);
    const result = yield* MessengerFileIngress.ingest(input, test.dependencies);
    expect(test.downloads).toEqual([]);
    expect(test.uploads).toEqual([]);
    expect(messageText(result)).toContain("authorization was denied");
  }),
);

it.effect("reports download failure without claiming file content was read", () =>
  Effect.gen(function* () {
    const test = harness();
    const result = yield* MessengerFileIngress.ingest(input, {
      ...test.dependencies,
      download: () => new MessengerAttachments.MessengerAttachmentFailed({ reason: "limit" }),
    });
    expect(test.uploads).toEqual([]);
    expect(messageText(result)).toContain("could not be read (limit)");
    expect(messageText(result)).not.toContain("is ready");
  }),
);

it.effect("rejects too many attachments without partially ingesting them", () =>
  Effect.gen(function* () {
    const test = harness();
    if (context.message === undefined) throw new Error("Missing fixture message");
    const result = yield* MessengerFileIngress.ingest(
      {
        ...input,
        context: {
          ...context,
          message: {
            ...context.message,
            attachments: Array.from({ length: 4 }, () => ({ mediaType: "image/png" })),
          },
        },
      },
      test.dependencies,
    );
    expect(test.downloads).toEqual([]);
    expect(test.uploads).toEqual([]);
    expect(messageText(result)).toContain("at most three");
  }),
);

it("supplies captionless admission text only when attachments exist", () => {
  if (context.message === undefined) throw new Error("Missing fixture message");
  expect(
    MessengerFileIngress.admissionText({ ...context, message: { ...context.message, text: "" } }),
  ).toBe("Please inspect the attached files.");
  expect(
    MessengerFileIngress.admissionText({
      ...context,
      message: { ...context.message, text: "", attachments: [] },
    }),
  ).toBe("");
});

it.effect("leaves ordinary messages unchanged", () =>
  Effect.gen(function* () {
    const test = harness();
    if (context.message === undefined) throw new Error("Missing fixture message");
    const message: UIMessage = {
      id: "text-1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }],
    };
    const result = yield* MessengerFileIngress.ingest(
      {
        ...input,
        context: { ...context, message: { ...context.message, attachments: [] } },
        userMessage: message,
      },
      test.dependencies,
    );
    expect(result).toBe(message);
    expect(test.downloads).toEqual([]);
  }),
);

const readyFile = Schema.decodeUnknownSync(FileRecord);

const messageText = (message: string | UIMessage) =>
  Predicate.isString(message)
    ? message
    : message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
