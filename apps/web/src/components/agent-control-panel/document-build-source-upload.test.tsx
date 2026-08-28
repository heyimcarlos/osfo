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
