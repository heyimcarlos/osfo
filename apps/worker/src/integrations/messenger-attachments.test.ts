/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import { MessengerAttachments } from "./messenger-attachments";

const options = {
  telegram: { token: "synthetic-token" },
  whatsapp: { accessToken: "synthetic-access-token" },
};
const telegramInput: MessengerAttachments.DownloadInput = {
  provider: "telegram",
  attachment: {
    fetchMetadata: { fileId: "telegram-file" },
    mediaType: "application/pdf",
    name: "report.pdf",
  },
  maximumBytes: 100,
};
const whatsappInput: MessengerAttachments.DownloadInput = {
  provider: "whatsapp",
  attachment: { fetchMetadata: { mediaId: "whatsapp-media" }, mediaType: "image/jpeg" },
  maximumBytes: 100,
};

it.effect(
  "retrieves Telegram media by preserved file ID and downloads its authenticated path",
  () =>
    Effect.gen(function* () {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ ok: true, result: { file_path: "documents/report.pdf" } }),
        )
        .mockResolvedValueOnce(new Response("%PDF-synthetic"));
      const result = yield* MessengerAttachments.make(options, fetcher).download(telegramInput);

      expect(new TextDecoder().decode(result.bytes)).toBe("%PDF-synthetic");
      expect(result).toMatchObject({ mediaType: "application/pdf", name: "report.pdf" });
      expect(fetcher).toHaveBeenNthCalledWith(
        1,
        "https://api.telegram.org/botsynthetic-token/getFile",
        expect.objectContaining({
          method: "POST",
          redirect: "manual",
          body: new URLSearchParams({ file_id: "telegram-file" }),
          signal: expect.any(AbortSignal),
        }),
      );
      expect(fetcher).toHaveBeenNthCalledWith(
        2,
        "https://api.telegram.org/file/botsynthetic-token/documents/report.pdf",
        expect.objectContaining({ redirect: "manual" }),
      );
    }),
);

it.effect.each([
  "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123",
  "https://scontent.xx.fbcdn.net/whatsapp/media",
])("authenticates both WhatsApp requests for %s", (url) =>
  Effect.gen(function* () {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ url }))
      .mockResolvedValueOnce(new Response(new Uint8Array([255, 216, 255])));
    const result = yield* MessengerAttachments.make(options, fetcher).download(whatsappInput);

    expect(result.bytes).toEqual(new Uint8Array([255, 216, 255]));
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://graph.facebook.com/v25.0/whatsapp-media",
      expect.objectContaining({
        headers: { authorization: "Bearer synthetic-access-token" },
        redirect: "manual",
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      url,
      expect.objectContaining({
        headers: { authorization: "Bearer synthetic-access-token" },
        redirect: "manual",
      }),
    );
  }),
);

it.effect.each([
  "https://attacker.invalid/media",
  "https://lookaside.fbsbx.com.attacker.invalid/media",
  "http://lookaside.fbsbx.com/media",
  "https://lookaside.fbsbx.com:8443/media",
  "https://user:password@lookaside.fbsbx.com/media",
])("rejects an unsafe WhatsApp metadata URL before sending credentials to %s", (url) =>
  Effect.gen(function* () {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ url }));
    const result = yield* MessengerAttachments.make(options, fetcher)
      .download(whatsappInput)
      .pipe(Effect.result);

    expect(result).toMatchObject({ failure: { reason: "invalid_metadata" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }),
);

it.effect.each([
  "../secret",
  "photos/../secret",
  "https://attacker.invalid/file",
  "photos/%2e%2e/secret",
])("rejects Telegram file path traversal or URL substitution %s", (filePath) =>
  Effect.gen(function* () {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: filePath } }));
    const result = yield* MessengerAttachments.make(options, fetcher)
      .download(telegramInput)
      .pipe(Effect.result);

    expect(result).toMatchObject({ failure: { reason: "invalid_metadata" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }),
);

it.effect("rejects unsupported media and missing identifiers without fetching a supplied URL", () =>
  Effect.gen(function* () {
    const fetcher = vi.fn<typeof fetch>();
    const attachments = MessengerAttachments.make(options, fetcher);
    const unsupported = yield* attachments
      .download({
        ...telegramInput,
        attachment: { ...telegramInput.attachment, mediaType: "audio/ogg" },
      })
      .pipe(Effect.result);
    const missing = yield* attachments
      .download({
        ...telegramInput,
        attachment: { mediaType: "application/pdf", url: "https://attacker.invalid/file" },
      })
      .pipe(Effect.result);
    const oversized = yield* attachments
      .download({ ...telegramInput, attachment: { ...telegramInput.attachment, size: 101 } })
      .pipe(Effect.result);

    expect(unsupported).toMatchObject({ failure: { reason: "unsupported" } });
    expect(missing).toMatchObject({ failure: { reason: "missing_metadata" } });
    expect(oversized).toMatchObject({ failure: { reason: "limit" } });
    expect(fetcher).not.toHaveBeenCalled();
  }),
);

it.effect("cancels an oversized body even when declared sizes claim it is small", () =>
  Effect.gen(function* () {
    const cancel = vi.fn<() => void>();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(80));
        controller.enqueue(new Uint8Array(30));
      },
      cancel,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ url: "https://lookaside.fbsbx.com/media" }))
      .mockResolvedValueOnce(new Response(body, { headers: { "content-length": "1" } }));
    const result = yield* MessengerAttachments.make(options, fetcher)
      .download({ ...whatsappInput, attachment: { ...whatsappInput.attachment, size: 1 } })
      .pipe(Effect.result);

    expect(result).toMatchObject({ failure: { reason: "limit" } });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  }),
);

it.effect("bounds metadata bodies and rejects malformed metadata", () =>
  Effect.gen(function* () {
    const oversized = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("x".repeat(16_385)));
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, result: {} }));

    expect(
      yield* MessengerAttachments.make(options, oversized)
        .download(telegramInput)
        .pipe(Effect.result),
    ).toMatchObject({ failure: { reason: "limit" } });
    expect(
      yield* MessengerAttachments.make(options, malformed)
        .download(telegramInput)
        .pipe(Effect.result),
    ).toMatchObject({ failure: { reason: "invalid_metadata" } });
  }),
);

it.effect(
  "rejects redirects and provider errors without returning credential-bearing evidence",
  () =>
    Effect.gen(function* () {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid/collect" },
        }),
      );
      const rejected = yield* MessengerAttachments.make(options, fetcher)
        .download(whatsappInput)
        .pipe(Effect.result);
      const unavailable = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error("synthetic-token in request URL"));
      const failed = yield* MessengerAttachments.make(options, unavailable)
        .download(telegramInput)
        .pipe(Effect.result);

      expect(rejected).toMatchObject({ failure: { reason: "unavailable" } });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(failed).toMatchObject({ failure: { reason: "unavailable" } });
      expect(Result.getFailure(failed)).not.toHaveProperty("value.cause");
    }),
);

it.effect("aborts and cancels a stalled download after the shared fifteen-second deadline", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cancel = vi.fn<() => void>();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const signals: Array<AbortSignal> = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ url: "https://lookaside.fbsbx.com/media" }))
      .mockImplementationOnce((_url, init) => {
        if (init?.signal) signals.push(init.signal);
        Deferred.doneUnsafe(started, Effect.void);
        return Promise.resolve(new Response(body));
      });
    const download = yield* MessengerAttachments.make(options, fetcher)
      .download(whatsappInput)
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("15 seconds");

    expect(yield* Fiber.join(download)).toMatchObject({ failure: { reason: "timeout" } });
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    expect(cancel).toHaveBeenCalledTimes(1);
  }),
);
