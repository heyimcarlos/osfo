import type { FileStatusResponse, FileUploadResponse } from "@osfo/api";
import { Effect } from "effect";
import { FileUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { inspectFileStatus, uploadTextFile } from "../../lib/api-client";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/global-timers, effecttsgo/crypto-random-uuid -- React state discriminators and browser scheduling are owned by this UI boundary. */

type UploadState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Uploading"; readonly fileName: string }
  | { readonly _tag: "Uploaded"; readonly result: FileUploadResponse }
  | { readonly _tag: "StatusUnavailable"; readonly result: FileUploadResponse }
  | { readonly _tag: "UploadUnavailable"; readonly pending: PendingUpload }
  | { readonly _tag: "Failed" };

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
  const requestGeneration = useRef(0);
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
            setState({ _tag: "Failed" });
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
        if (requestGeneration.current === generation) setState({ _tag: "Uploaded", result });
      },
      () => {
        if (requestGeneration.current === generation) {
          setState({ _tag: "UploadUnavailable", pending });
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
          if (requestGeneration.current === generation) setState({ _tag: "Failed" });
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
      {state._tag === "Uploading" ? (
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
          The source could not be uploaded. Try again with a smaller UTF-8 text file.
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
