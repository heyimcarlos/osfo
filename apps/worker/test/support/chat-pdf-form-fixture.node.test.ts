/* oxlint-disable effecttsgo/global-fetch-in-effect, effecttsgo/node-builtin-import -- This test owns local emulator HTTP I/O and reads a synthetic media fixture. */
import { readFile } from "node:fs/promises";
import { TelegramAdapter } from "@chat-adapter/telegram";
import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { PDFDocument } from "pdf-lib";
import { ContentId } from "../../src/domain/client-content";
import { FileId } from "../../src/domain/file";
import { FileDigest, inspectFileContent } from "../../src/domain/file-content";
import { fill } from "../../src/integrations/pdf/pdf-form";
import { MessengerAttachments } from "../../src/integrations/messenger-attachments";
import { startRunProviderEmulator } from "../emulators/provider-emulator";
import { create, digest, edits, inspectDownload } from "./chat-pdf-form-fixture";

it.effect(
  "accepts actual filled widgets but rejects an invented interpretation of an ambiguous date",
  () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(create);
      const filled = yield* fill(
        ContentId.make("document:toolCall:verification"),
        fixture.template,
        {
          templateFileId: FileId.make("verification-template"),
          templateDigest: FileDigest.make(digest(fixture.template)),
          pageCount: 1,
          fields: edits,
        },
      );
      const inspected = yield* Effect.promise(() => inspectDownload(filled.bytes));
      expect(inspected.text.DocumentDateLiteral).toBe("03/04/2026");
      expect(inspected.text.UnknownDate).toBe("");
      const altered = yield* Effect.promise(() => PDFDocument.load(filled.bytes));
      altered.getForm().getTextField("DocumentDateLiteral").setText("2026-03-04");
      const alteredBytes = yield* Effect.promise(() => altered.save());
      const result = yield* Effect.tryPromise(() => inspectDownload(alteredBytes)).pipe(
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
);

it.effect("serves registered source bytes through the real Telegram media adapter", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => startRunProviderEmulator("chat-pdf-form-test")),
    (provider) =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(create);
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          image:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=",
          template: Buffer.from(fixture.template).toString("base64"),
        });
        const registered = yield* Effect.promise(() =>
          fetch(`${provider.origin}/_test/chat-pdf-form/media`, {
            method: "POST",
            body,
            headers: { "content-type": "application/json" },
          }),
        );
        expect(registered.status).toBe(400);
        const photoBytes = yield* Effect.promise(() =>
          readFile(new URL("../fixtures/chat-pdf-form-photo.jpg", import.meta.url)),
        );
        const photoBody = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          image: photoBytes.toString("base64"),
          template: Buffer.from(fixture.template).toString("base64"),
        });
        const accepted = yield* Effect.promise(() =>
          fetch(`${provider.origin}/_test/chat-pdf-form/media`, {
            method: "POST",
            body: photoBody,
            headers: { "content-type": "application/json" },
          }),
        );
        expect(accepted.status).toBe(201);
        const adapter = new TelegramAdapter({ botToken: "telegram-test-bot-token" });
        const parsed = adapter.parseMessage({
          message_id: 1,
          date: 1,
          chat: { id: 42, type: "private" },
          from: { id: 42, is_bot: false, first_name: "Verification" },
          photo: [
            {
              file_id: "verification-evidence",
              file_unique_id: "verification-evidence",
              file_size: photoBytes.byteLength,
              width: 8,
              height: 8,
            },
          ],
        });
        const photo = parsed.attachments[0];
        expect(photo?.mimeType).toBe("image/jpeg");
        if (photo?.mimeType === undefined)
          return yield* Effect.die(new Error("Expected photo MIME metadata"));
        const media = MessengerAttachments.make({
          telegram: { token: "telegram-test-bot-token", apiBaseURL: provider.origin },
          whatsapp: { accessToken: "unused" },
        });
        const downloaded = yield* media.download({
          provider: "telegram",
          maximumBytes: 1_000_000,
          attachment: {
            mediaType: "application/pdf",
            fetchMetadata: { fileId: "verification-template" },
          },
        });
        expect(downloaded.bytes).toEqual(fixture.template);
        const downloadedPhoto = yield* media.download({
          provider: "telegram",
          maximumBytes: 1_000_000,
          attachment: {
            mediaType: photo.mimeType,
            fetchMetadata: { fileId: "verification-evidence" },
          },
        });
        const inspectedPhoto = yield* inspectFileContent({
          bytes: downloadedPhoto.bytes,
          declaredMediaType: photo.mimeType,
        });
        expect(inspectedPhoto.mediaType).toBe("image/jpeg");
        expect(inspectedPhoto.sha256).toBe(digest(photoBytes));
        const servedPhoto = yield* Effect.promise(() =>
          fetch(`${provider.origin}/file/bottelegram-test-bot-token/verification-evidence`),
        );
        expect(servedPhoto.headers.get("content-type")).toBe("image/jpeg");

        const modelBody = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          messages: [
            {
              role: "user",
              content:
                "Read the attached synthetic document.\nOsfo attachment ingestion results:\nAttachment 1: owned File actual-file is ready. Read it with readFile.",
            },
          ],
          tools: [{ function: { name: "readFile" } }],
        });
        const modelResponse = yield* Effect.promise(() =>
          fetch(`${provider.origin}/_local/research/agent`, {
            method: "POST",
            body: modelBody,
            headers: { "content-type": "application/json" },
          }),
        );
        expect(modelResponse.status).toBe(200);
        expect(yield* Effect.promise(() => modelResponse.json())).toMatchObject({
          tool_calls: [{ name: "readFile", arguments: { fileId: "actual-file" } }],
        });
        const downloadUrl =
          "http://127.0.0.1:4173/documents/download?contentId=document%3AtoolCall%3Aretained";
        const deliveryBody = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          chat_id: 42,
          text: `Download document: ${downloadUrl}`,
        });
        yield* Effect.promise(() =>
          fetch(`${provider.origin}/bottelegram-test-bot-token/sendMessage`, {
            method: "POST",
            body: deliveryBody,
            headers: { "content-type": "application/json" },
          }),
        );
        const inbox = yield* Effect.promise(() =>
          fetch(`${provider.origin}/inbox?history=1`).then((response) => response.text()),
        );
        expect(inbox).toContain(`<a href="${downloadUrl}">Download document</a>`);
        return undefined;
      }),
    (provider) => Effect.promise(provider.close),
  ),
);
