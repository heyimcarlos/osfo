import {
  BrowserFileId,
  FileUploadConflict,
  FileUploadDenied,
  FileUploadLimitExceeded,
  FileUploadRejected,
  type FileStatusResponse,
  type FileUploadResponse,
} from "@osfo/api";
import { Effect, Option, Schema } from "effect";
import { FileUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { inspectFileStatus, uploadTextFile } from "../../lib/api-client";
import {
  forgetDocumentBuildSource,
  loadDocumentBuildSource,
  rememberDocumentBuildSource,
} from "./document-build-source-storage";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/global-timers, effecttsgo/crypto-random-uuid -- React state discriminators and browser scheduling are owned by this UI boundary. */

type UploadState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "CheckingSource" }
  | { readonly _tag: "RecoveryUnavailable"; readonly fileId: string }
  | { readonly _tag: "Uploading"; readonly fileName: string }
  | { readonly _tag: "Uploaded"; readonly result: FileUploadResponse }
  | { readonly _tag: "StatusUnavailable"; readonly result: FileUploadResponse }
  | { readonly _tag: "UploadUnavailable"; readonly pending: PendingUpload }
  | { readonly _tag: "Failed"; readonly message: string };

interface PendingUpload {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly uploadId: string;
}

const inspectUploadedFile = (fileId: string) => Effect.runPromise(inspectFileStatus(fileId));
const makeBrowserUploadId = () => crypto.randomUUID();
const uploadSourceFile = (bytes: Uint8Array, fileName: string, uploadId: string) =>
  Effect.runPromise(uploadTextFile(bytes, fileName, uploadId));

/** Minimal authenticated source ingress for Document Build. */
export function DocumentBuildSourceUpload({
  inspect = inspectUploadedFile,
  makeUploadId = makeBrowserUploadId,
  pollDelayMilliseconds = 1_000,
  uploadFile = uploadSourceFile,
}: DocumentBuildSourceUploadProps = {}) {
  const [state, setState] = useState<UploadState>({ _tag: "Idle" });
  const [existingFileId, setExistingFileId] = useState("");
  const requestGeneration = useRef(0);
  const recover = useCallback(
    (fileId: string) => {
      const generation = requestGeneration.current + 1;
      requestGeneration.current = generation;
      setState({ _tag: "CheckingSource" });
      void inspect(fileId).then(
        (result) => {
          if (requestGeneration.current !== generation) return;
          if (result.state === "failed") {
            forgetDocumentBuildSource();
            setState({
              _tag: "Failed",
              message: "The source file could not be processed. Choose it again.",
            });
            return;
          }
          rememberDocumentBuildSource(result.fileId);
          setState({ _tag: "Uploaded", result: { ...result, state: result.state } });
        },
        (failure) => {
          if (requestGeneration.current !== generation) return;
          if (Schema.is(FileUploadDenied)(failure)) {
            forgetDocumentBuildSource();
            setState({
              _tag: "Failed",
              message:
                "This source is not available to your account. Upload it again or use another File ID.",
            });
            return;
          }
          setState({ _tag: "RecoveryUnavailable", fileId });
        },
      );
    },
    [inspect],
  );
  useEffect(() => {
    const fileId = loadDocumentBuildSource();
    if (fileId !== null) recover(fileId);
  }, [recover]);
  useEffect(
    () => () => {
      requestGeneration.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (state._tag !== "Uploaded" || state.result.state !== "processing") return undefined;
    const generation = requestGeneration.current;
    const timeout = setTimeout(() => {
      void inspect(state.result.fileId).then(
        (result) => {
          if (requestGeneration.current !== generation) return;
          if (result.state === "failed") {
            setState({ _tag: "Failed", message: "The source file could not be processed." });
            return;
          }
          setState({
            _tag: "Uploaded",
            result: {
              fileId: result.fileId,
              fileName: result.fileName,
              mediaType: result.mediaType,
              state: result.state,
            },
          });
        },
        () => {
          if (requestGeneration.current === generation) {
            setState({ _tag: "StatusUnavailable", result: state.result });
          }
        },
      );
    }, pollDelayMilliseconds);
    return () => clearTimeout(timeout);
  }, [inspect, pollDelayMilliseconds, state]);
  const send = (pending: PendingUpload, generation: number) => {
    setState({ _tag: "Uploading", fileName: pending.fileName });
    return void uploadFile(pending.bytes, pending.fileName, pending.uploadId).then(
      (result) => {
        if (requestGeneration.current === generation) {
          rememberDocumentBuildSource(result.fileId);
          setState({ _tag: "Uploaded", result });
        }
      },
      (failure) => {
        if (requestGeneration.current === generation) {
          const permanent = Option.getOrUndefined(decodePermanentUploadFailure(failure));
          setState(
            permanent === undefined
              ? { _tag: "UploadUnavailable", pending }
              : { _tag: "Failed", message: permanentUploadFailureMessage(permanent) },
          );
        }
      },
    );
  };
  const upload = (file: File) => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    const uploadId = makeUploadId();
    setState({ _tag: "Uploading", fileName: file.name });
    return void file
      .arrayBuffer()
      .then((buffer) => {
        if (requestGeneration.current !== generation) return;
        send({ bytes: new Uint8Array(buffer), fileName: file.name, uploadId }, generation);
      })
      .then(
        () => undefined,
        () => {
          if (requestGeneration.current === generation) {
            setState({
              _tag: "Failed",
              message: "The source file could not be read. Choose it again.",
            });
          }
        },
      );
  };

  return (
    <section className="relative z-10 mt-3 rounded-2xl border border-white/85 bg-white/65 p-4 shadow-[0_8px_24px_rgba(45,68,110,0.1)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[#101936]">Document Build source</h2>
          <p className="mt-1 text-xs text-[#687896]">
            Upload a UTF-8 text file, then give its File ID to your linked Agent.
          </p>
        </div>
        <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl bg-[#2568ca] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1f5ab1] focus-within:ring-2 focus-within:ring-[#2f7df4] focus-within:ring-offset-2">
          <FileUp aria-hidden="true" className="size-4" />
          Choose text file
          <input
            accept=".txt,text/plain"
            className="sr-only"
            type="file"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file !== undefined) upload(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const fileId = existingFileId.trim();
          if (!Schema.is(BrowserFileId)(fileId)) return;
          setExistingFileId("");
          recover(fileId);
        }}
      >
        <label className="grid gap-1 text-xs text-[#687896]">
          Existing File ID
          <input
            className="min-h-10 rounded-lg border border-[#c6d4e9] bg-white px-3 text-sm text-[#101936]"
            maxLength={160}
            required
            value={existingFileId}
            onChange={(event) => setExistingFileId(event.currentTarget.value)}
          />
        </label>
        <button
          className="min-h-10 rounded-lg px-3 text-sm font-semibold text-[#2568ca] hover:bg-[#edf4ff]"
          type="submit"
        >
          Use existing source
        </button>
      </form>
      {state._tag === "CheckingSource" ? (
        <p className="mt-3 text-xs text-[#687896]" role="status">
          Checking source...
        </p>
      ) : state._tag === "RecoveryUnavailable" ? (
        <div className="mt-3 text-xs text-[#8a6a21]" role="alert">
          <p>The source could not be checked. Try again.</p>
          <button
            className="mt-2 font-semibold text-[#2568ca] hover:underline"
            type="button"
            onClick={() => recover(state.fileId)}
          >
            Retry source
          </button>
        </div>
      ) : state._tag === "Uploading" ? (
        <p className="mt-3 text-xs text-[#687896]" role="status">
          Uploading {state.fileName}…
        </p>
      ) : state._tag === "Uploaded" ? (
        <p className="mt-3 text-xs text-[#2e5e49]" role="status">
          {state.result.state === "ready" ? "Ready" : "Processing"}. File ID:{" "}
          <code className="select-all rounded bg-[#edf4ff] px-1.5 py-1 text-[#101936]">
            {state.result.fileId}
          </code>
        </p>
      ) : state._tag === "Failed" ? (
        <p className="mt-3 text-xs text-[#b24a55]" role="alert">
          {state.message}
        </p>
      ) : state._tag === "UploadUnavailable" ? (
        <div className="mt-3 text-xs text-[#8a6a21]" role="alert">
          <p>The upload result is temporarily unavailable.</p>
          <button
            className="mt-2 font-semibold text-[#2568ca] hover:underline"
            type="button"
            onClick={() => {
              const generation = requestGeneration.current + 1;
              requestGeneration.current = generation;
              send(state.pending, generation);
            }}
          >
            Retry upload
          </button>
        </div>
      ) : state._tag === "StatusUnavailable" ? (
        <div className="mt-3 text-xs text-[#8a6a21]" role="alert">
          <p>
            Status is temporarily unavailable. File ID:{" "}
            <code className="select-all rounded bg-[#edf4ff] px-1.5 py-1 text-[#101936]">
              {state.result.fileId}
            </code>
          </p>
          <button
            className="mt-2 font-semibold text-[#2568ca] hover:underline"
            type="button"
            onClick={() => setState({ _tag: "Uploaded", result: state.result })}
          >
            Retry status
          </button>
        </div>
      ) : null}
    </section>
  );
}

const PermanentUploadFailure = Schema.Union([
  FileUploadDenied,
  FileUploadRejected,
  FileUploadLimitExceeded,
  FileUploadConflict,
]);
type PermanentUploadFailure = typeof PermanentUploadFailure.Type;
const decodePermanentUploadFailure = Schema.decodeUnknownOption(PermanentUploadFailure);

const permanentUploadFailureMessage = (failure: PermanentUploadFailure) => {
  if (Schema.is(FileUploadDenied)(failure)) return "Your account cannot upload this source.";
  if (Schema.is(FileUploadRejected)(failure)) {
    return "The selected source was rejected. Choose a valid UTF-8 text file.";
  }
  if (Schema.is(FileUploadLimitExceeded)(failure)) {
    return "Your retained file limit has been reached.";
  }
  if (Schema.is(FileUploadConflict)(failure)) {
    return "This upload no longer matches its original content. Choose the file again.";
  }
  return "The source upload was rejected.";
};

export interface DocumentBuildSourceUploadProps {
  readonly inspect?: (fileId: string) => Promise<FileStatusResponse>;
  readonly makeUploadId?: () => string;
  readonly pollDelayMilliseconds?: number;
  readonly uploadFile?: (
    bytes: Uint8Array,
    fileName: string,
    uploadId: string,
  ) => Promise<FileUploadResponse>;
}
