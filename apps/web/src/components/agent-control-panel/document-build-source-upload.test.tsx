// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { DocumentBuildSourceUpload } from "./document-build-source-upload";

/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise -- Testing Library and the controlled upload boundary own browser Promises. */

const inspectFileStatus = vi.fn<(fileId: string) => Promise<FileResult>>();
const uploadTextFile =
  vi.fn<(bytes: Uint8Array, fileName: string, uploadId: string) => Promise<UploadResult>>();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  inspectFileStatus.mockReset();
  uploadTextFile.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DocumentBuildSourceUpload", () => {
  it("shows upload, processing, and ready states with the owning File ID", async () => {
    let completeUpload: ((result: UploadResult) => void) | undefined;
    uploadTextFile.mockReturnValue(
      new Promise<UploadResult>((resolve) => {
        completeUpload = resolve;
      }),
    );
    inspectFileStatus.mockResolvedValue({
      fileId: "web:11111111-1111-4111-8111-111111111111",
      fileName: "source.txt",
      mediaType: "text/plain",
      state: "ready" as const,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <DocumentBuildSourceUpload
        inspect={inspectFileStatus}
        makeUploadId={() => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
        pollDelayMilliseconds={1_000}
        uploadFile={uploadTextFile}
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose text file"),
      new File(["Document Build source"], "source.txt", { type: "text/plain" }),
    );
    expect(screen.getByRole("status").textContent).toContain("Uploading source.txt");
    expect(uploadTextFile).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "source.txt",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );

    await act(async () => {
      completeUpload?.({
        fileId: "web:11111111-1111-4111-8111-111111111111",
        fileName: "source.txt",
        mediaType: "text/plain",
        state: "processing",
      });
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toContain("Processing. File ID:");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(inspectFileStatus).toHaveBeenCalledWith("web:11111111-1111-4111-8111-111111111111");
    expect(screen.getByRole("status").textContent).toBe(
      "Ready. File ID: web:11111111-1111-4111-8111-111111111111",
    );
  });

  it("shows a safe failure when upload is rejected", async () => {
    uploadTextFile.mockRejectedValue({ _tag: "TestUploadFailure", detail: "private failure" });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <DocumentBuildSourceUpload
        inspect={inspectFileStatus}
        makeUploadId={() => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
        uploadFile={uploadTextFile}
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose text file"),
      new File(["Document Build source"], "source.txt", { type: "text/plain" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The source could not be uploaded. Try again with a smaller UTF-8 text file.",
    );
    expect(document.body.textContent).not.toContain("private failure");
  });

  it("keeps the newest file when two uploads complete out of order", async () => {
    let completeFirst: ((result: UploadResult) => void) | undefined;
    let completeSecond: ((result: UploadResult) => void) | undefined;
    uploadTextFile
      .mockReturnValueOnce(
        new Promise<UploadResult>((resolve) => {
          completeFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<UploadResult>((resolve) => {
          completeSecond = resolve;
        }),
      );
    const makeUploadId = vi
      .fn<() => string>()
      .mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .mockReturnValueOnce("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <DocumentBuildSourceUpload
        inspect={inspectFileStatus}
        makeUploadId={makeUploadId}
        uploadFile={uploadTextFile}
      />,
    );
    const input = screen.getByLabelText("Choose text file");

    await user.upload(input, new File(["first"], "first.txt", { type: "text/plain" }));
    await user.upload(input, new File(["second"], "second.txt", { type: "text/plain" }));
    await act(async () => {
      completeSecond?.(readyUpload("web:second", "second.txt"));
      await Promise.resolve();
    });
    await act(async () => {
      completeFirst?.(readyUpload("web:first", "first.txt"));
      await Promise.resolve();
    });

    expect(screen.getByRole("status").textContent).toContain("web:second");
    expect(document.body.textContent).not.toContain("web:first");
  });

  it("ignores a stale processing poll after a newer upload starts", async () => {
    let completePoll: ((result: FileResult) => void) | undefined;
    uploadTextFile
      .mockResolvedValueOnce({
        fileId: "web:first",
        fileName: "first.txt",
        mediaType: "text/plain",
        state: "processing",
      })
      .mockResolvedValueOnce(readyUpload("web:second", "second.txt"));
    inspectFileStatus.mockReturnValue(
      new Promise<FileResult>((resolve) => {
        completePoll = resolve;
      }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <DocumentBuildSourceUpload
        inspect={inspectFileStatus}
        makeUploadId={() => "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}
        pollDelayMilliseconds={1_000}
        uploadFile={uploadTextFile}
      />,
    );
    const input = screen.getByLabelText("Choose text file");

    await user.upload(input, new File(["first"], "first.txt", { type: "text/plain" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(inspectFileStatus).toHaveBeenCalledWith("web:first");
    await user.upload(input, new File(["second"], "second.txt", { type: "text/plain" }));
    await screen.findByText(/web:second/u);
    await act(async () => {
      completePoll?.({
        fileId: "web:first",
        fileName: "first.txt",
        mediaType: "text/plain",
        state: "failed",
      });
      await Promise.resolve();
    });

    expect(screen.getByRole("status").textContent).toContain("web:second");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

const readyUpload = (fileId: string, fileName: string): UploadResult => ({
  fileId,
  fileName,
  mediaType: "text/plain",
  state: "ready",
});

interface UploadResult {
  readonly fileId: string;
  readonly fileName: string;
  readonly mediaType: "text/plain";
  readonly state: "processing" | "ready";
}

type FileResult =
  | UploadResult
  | {
      readonly fileId: string;
      readonly fileName: string;
      readonly mediaType: "text/plain";
      readonly state: "failed";
    };
