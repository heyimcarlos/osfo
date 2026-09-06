// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  FileUploadConflict,
  FileUploadDenied,
  FileUploadLimitExceeded,
  FileUploadRejected,
  FileUploadUnavailable,
} from "@osfo/api";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { DocumentBuildSourceUpload } from "./document-build-source-upload";
import {
  loadDocumentBuildSource,
  rememberDocumentBuildSource,
} from "./document-build-source-storage";

/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise -- Testing Library and the controlled upload boundary own browser Promises. */

const inspectFileStatus = vi.fn<(fileId: string) => Promise<FileResult>>();
const uploadTextFile =
  vi.fn<(bytes: Uint8Array, fileName: string, uploadId: string) => Promise<UploadResult>>();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  sessionStorage.clear();
  inspectFileStatus.mockReset();
  uploadTextFile.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DocumentBuildSourceUpload", () => {
  it("recovers an existing owned File ID without uploading it again", async () => {
    const file = readyUpload("web:existing", "source.txt");
    inspectFileStatus.mockResolvedValue(file);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DocumentBuildSourceUpload inspect={inspectFileStatus} uploadFile={uploadTextFile} />);
    const input = screen.getByRole("textbox", { name: "Existing File ID" });
    await user.type(input, "web:existing");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(file.fileId)).toBeDefined();
    expect(document.activeElement).toBe(input);
    expect(inspectFileStatus).toHaveBeenCalledExactlyOnceWith(file.fileId);
    expect(uploadTextFile).not.toHaveBeenCalled();
    expect(loadDocumentBuildSource()).toBe(file.fileId);
    expect(sessionStorage.getItem(sessionStorage.key(0) ?? "")).toBe(file.fileId);
  });

  it("hides a previous account's source until inspection and clears a denied cached source", async () => {
    const file = readyUpload("web:previous-account", "private-source.txt");
    uploadTextFile.mockResolvedValue(file);
    let rejectInspection: ((reason: FileUploadDenied) => void) | undefined;
    inspectFileStatus.mockReturnValue(
      new Promise<FileResult>((_, reject) => {
        rejectInspection = reject;
      }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const props = { inspect: inspectFileStatus, uploadFile: uploadTextFile };
    const page = render(<DocumentBuildSourceUpload key="first-account" {...props} />);
    await user.upload(
      screen.getByLabelText("Choose text file"),
      new File(["source"], file.fileName, { type: "text/plain" }),
    );
    await screen.findByText(file.fileId);
    page.rerender(<DocumentBuildSourceUpload key="second-account" {...props} />);
    expect(screen.getByRole("status").textContent).toBe("Checking source...");
    expect(document.body.textContent).not.toContain(file.fileId);
    expect(document.body.textContent).not.toContain(file.fileName);
    await act(async () => {
      rejectInspection?.(new FileUploadDenied({ message: "private authority detail" }));
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toContain("not available to your account");
    expect(document.body.textContent).not.toContain("private");
    expect(loadDocumentBuildSource()).toBeNull();
    page.unmount();
    render(<DocumentBuildSourceUpload key="third-account" {...props} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(inspectFileStatus).toHaveBeenCalledTimes(1);
  });

  it("retains an unavailable recovery hint for retry without displaying cached source data", async () => {
    rememberDocumentBuildSource("web:retained");
    inspectFileStatus
      .mockRejectedValueOnce(new FileUploadUnavailable({ message: "private failure" }))
      .mockResolvedValueOnce(readyUpload("web:retained", "source.txt"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DocumentBuildSourceUpload inspect={inspectFileStatus} uploadFile={uploadTextFile} />);
    await screen.findByRole("alert");
    expect(document.body.textContent).not.toContain("web:retained");
    expect(loadDocumentBuildSource()).toBe("web:retained");
    await user.click(screen.getByRole("button", { name: "Retry source" }));
    expect(await screen.findByText("web:retained")).toBeDefined();
  });

  it("continues uploading when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    uploadTextFile.mockResolvedValue(readyUpload("web:unstored", "source.txt"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DocumentBuildSourceUpload inspect={inspectFileStatus} uploadFile={uploadTextFile} />);
    await user.upload(
      screen.getByLabelText("Choose text file"),
      new File(["source"], "source.txt", { type: "text/plain" }),
    );
    expect(await screen.findByText("web:unstored")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not let stale recovery clear a newer uploaded source", async () => {
    rememberDocumentBuildSource("web:previous");
    let rejectInspection: ((reason: FileUploadDenied) => void) | undefined;
    inspectFileStatus.mockReturnValue(
      new Promise<FileResult>((_, reject) => {
        rejectInspection = reject;
      }),
    );
    uploadTextFile.mockResolvedValue(readyUpload("web:new", "new.txt"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DocumentBuildSourceUpload inspect={inspectFileStatus} uploadFile={uploadTextFile} />);
    await user.upload(
      screen.getByLabelText("Choose text file"),
      new File(["new"], "new.txt", { type: "text/plain" }),
    );
    await screen.findByText("web:new");
    await act(async () => {
      rejectInspection?.(new FileUploadDenied({ message: "no longer owned" }));
      await Promise.resolve();
    });
    expect(screen.getByText("web:new")).toBeDefined();
    expect(loadDocumentBuildSource()).toBe("web:new");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("recovers the uploaded source after the panel remounts", async () => {
    const uploaded = readyUpload("web:11111111-1111-4111-8111-111111111111", "source.txt");
    uploadTextFile.mockResolvedValue(uploaded);
    inspectFileStatus.mockResolvedValue(uploaded);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const props = {
      inspect: inspectFileStatus,
      makeUploadId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      uploadFile: uploadTextFile,
    };
    const page = render(<DocumentBuildSourceUpload {...props} />);
    await user.upload(
      screen.getByLabelText("Choose text file"),
      new File(["source"], "source.txt", { type: "text/plain" }),
    );
    await screen.findByText(uploaded.fileId);
    page.unmount();
    render(<DocumentBuildSourceUpload {...props} />);
    expect(await screen.findByText(uploaded.fileId)).toBeDefined();
    expect(inspectFileStatus).toHaveBeenCalledWith(uploaded.fileId);
    expect(uploadTextFile).toHaveBeenCalledTimes(1);
  });

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

  it("shows a safe retry after an ambiguous upload failure", async () => {
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
      "The upload result is temporarily unavailable.Retry upload",
    );
    expect(document.body.textContent).not.toContain("private failure");
  });

  it.each([
    [
      new FileUploadDenied({ message: "private denial" }),
      "Your account cannot upload this source.",
    ],
    [
      new FileUploadRejected({ message: "private rejection" }),
      "The selected source was rejected. Choose a valid UTF-8 text file.",
    ],
    [
      new FileUploadLimitExceeded({ message: "private limit" }),
      "Your retained file limit has been reached.",
    ],
    [
      new FileUploadConflict({ message: "private conflict" }),
      "This upload no longer matches its original content. Choose the file again.",
    ],
  ])(
    "shows a non-retryable safe message for permanent upload failures",
    async (failure, message) => {
      uploadTextFile.mockRejectedValue(failure);
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

      expect((await screen.findByRole("alert")).textContent).toBe(message);
      expect(screen.queryByRole("button", { name: "Retry upload" })).toBeNull();
      expect(document.body.textContent).not.toContain("private");
    },
  );

  it("preserves retry identity for a typed transient upload failure", async () => {
    uploadTextFile
      .mockRejectedValueOnce(new FileUploadUnavailable({ message: "temporary" }))
      .mockResolvedValueOnce(readyUpload("web:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "source.txt"));
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
    await user.click(await screen.findByRole("button", { name: "Retry upload" }));
    await screen.findByText(/web:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/u);

    expect(uploadTextFile).toHaveBeenCalledTimes(2);
    expect(uploadTextFile.mock.calls[1]).toEqual(uploadTextFile.mock.calls[0]);
  });

  it("retries a response-lost upload with the exact same identity and bytes", async () => {
    uploadTextFile
      .mockRejectedValueOnce(new Error("response lost after commit"))
      .mockResolvedValueOnce(readyUpload("web:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "source.txt"));
    const makeUploadId = vi.fn<() => string>(() => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <DocumentBuildSourceUpload
        inspect={inspectFileStatus}
        makeUploadId={makeUploadId}
        uploadFile={uploadTextFile}
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose text file"),
      new File(["Document Build source"], "source.txt", { type: "text/plain" }),
    );
    await screen.findByRole("button", { name: "Retry upload" });
    await user.click(screen.getByRole("button", { name: "Retry upload" }));
    await screen.findByText(/web:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/u);

    expect(makeUploadId).toHaveBeenCalledTimes(1);
    expect(uploadTextFile).toHaveBeenCalledTimes(2);
    const first = uploadTextFile.mock.calls[0];
    const second = uploadTextFile.mock.calls[1];
    expect(second?.[0]).toEqual(first?.[0]);
    expect(second?.slice(1)).toEqual(first?.slice(1));
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

  it("preserves the File ID and offers retry when status inspection is unavailable", async () => {
    uploadTextFile.mockResolvedValue({
      fileId: "web:status-unavailable",
      fileName: "source.txt",
      mediaType: "text/plain",
      state: "processing",
    });
    inspectFileStatus
      .mockRejectedValueOnce(new Error("temporary status outage"))
      .mockResolvedValueOnce(readyUpload("web:status-unavailable", "source.txt"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <DocumentBuildSourceUpload
        inspect={inspectFileStatus}
        makeUploadId={() => "dddddddd-dddd-4ddd-8ddd-dddddddddddd"}
        pollDelayMilliseconds={1_000}
        uploadFile={uploadTextFile}
      />,
    );

    const file = new File(["source"], "source.txt", { type: "text/plain" });
    vi.spyOn(file, "arrayBuffer").mockImplementation(
      // oxlint-disable-next-line effecttsgo/global-timers -- This browser fixture delays file reading on Vitest fake timers.
      () => new Promise((resolve) => setTimeout(() => resolve(new ArrayBuffer(6)), 500)),
    );
    await user.upload(screen.getByLabelText("Choose text file"), file);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Processing"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole("alert").textContent).toContain("web:status-unavailable");
    await user.click(screen.getByRole("button", { name: "Retry status" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.getByRole("status").textContent).toContain("Ready. File ID:");
    expect(screen.getByRole("status").textContent).toContain("web:status-unavailable");
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
