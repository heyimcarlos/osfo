import type { ModelMessage, UIMessage } from "ai";
import { Effect, Schema } from "effect";
import { ChannelLinkId, ThinkSubmissionId, UserId } from "../../src/domain";
import { ChannelAddress } from "../../src/domain/channel-link";
import { FileRecord, type FileId } from "../../src/domain/file";
import { FileContentUnavailable } from "../../src/services/files";
import { MessengerFileIngress } from "../../src/agents/osfo/messenger-file-ingress";

export const metadata = {
  authorityIdentity: {
    _tag: "ChannelLink" as const,
    address: Schema.decodeSync(ChannelAddress)({ authorId: "sender-1", channelId: "whatsapp" }),
    channelLinkId: ChannelLinkId.make("link-1"),
    userId: UserId.make("user-1"),
  },
  submissionId: ThinkSubmissionId.make("submission-1"),
};
export const messenger = {
  capabilities: {},
  kind: "direct-message",
  provider: "whatsapp",
  messengerId: "whatsapp",
  thread: { id: "thread-1", providerThreadId: "sender-1", isDirectMessage: true },
  message: {
    id: "provider-1",
    providerMessageId: "provider-1",
    author: { userId: "sender-1" },
    text: "Read the attached reference; retain unknown fields.",
    attachments: [{ mediaType: "application/pdf", fetchMetadata: { mediaId: "media-1" } }],
  },
};
export const source: UIMessage = {
  id: metadata.submissionId,
  role: "user",
  metadata: { messenger },
  parts: [{ type: "file", mediaType: "application/pdf", url: "https://media.invalid/private" }],
};
export const history: Array<ModelMessage> = [
  { role: "user", content: "Earlier question" },
  { role: "assistant", content: "Earlier reply" },
  {
    role: "user",
    content: [
      {
        type: "file",
        mediaType: "application/pdf",
        data: new URL("https://media.invalid/private"),
      },
    ],
  },
  { role: "assistant", content: "Retained continuation" },
];

export const harness = () => {
  const persisted: Array<UIMessage> = [];
  const files = new Map<FileId, Extract<FileRecord, { readonly state: "ready" }>>();
  const events: Array<string> = [];
  const bytes = new TextEncoder().encode("%PDF-synthetic");
  const dependencies: MessengerFileIngress.Dependencies<never, never, FileContentUnavailable> & {
    persist: (message: UIMessage) => Effect.Effect<void>;
  } = {
    authorize: Effect.sync(() => {
      events.push("authorize");
      return true;
    }),
    read: ({ fileId }) => {
      const file = files.get(fileId);
      return file === undefined
        ? new FileContentUnavailable({ fileId, message: "No retained file" })
        : Effect.succeed({ _tag: "FileRead", bytes, file });
    },
    download: () =>
      Effect.sync(() => {
        events.push("download");
        return { bytes, mediaType: "application/pdf", name: undefined };
      }),
    upload: (input) =>
      Effect.sync(() => {
        events.push("upload");
        const file = Schema.decodeUnknownSync(FileRecord)({
          ...input,
          acceptedAt: "2026-09-05T00:00:00.000Z",
          allowancePeriodId: "period-1",
          byteLength: BigInt(bytes.byteLength),
          mediaType: input.declaredMediaType,
          objectKey: `owned/${input.fileId}`,
          sha256: `sha256:${"a".repeat(64)}`,
          userId: metadata.authorityIdentity.userId,
          deletedAt: null,
          normalizationError: null,
          normalizationClaimedAt: null,
          normalizedText: "[Page 1 — ocr]\nReference: SAMPLE-4821",
          provenanceJson: "{}",
          state: "ready",
        });
        if (file.state !== "ready") throw new Error("Expected ready fixture");
        files.set(input.fileId, file);
        return { _tag: "FileReady", file };
      }),
    persist: (message) =>
      Effect.sync(() => {
        events.push("persist");
        persisted.push(message);
      }),
  };
  return { dependencies, persisted, files, events };
};

