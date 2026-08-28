import type { FileStatusResponse, FileUploadResponse } from "@osfo/api";
import { Effect } from "effect";
import { FileUp } from "lucide-react";
import { useEffect, useState } from "react";

import { inspectFileStatus, uploadTextFile } from "../../lib/api-client";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/global-timers, effecttsgo/crypto-random-uuid -- React state discriminators and browser scheduling are owned by this UI boundary. */

type UploadState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Uploading"; readonly fileName: string }
  | { readonly _tag: "Uploaded"; readonly result: FileUploadResponse }
  | { readonly _tag: "Failed" };

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
  useEffect(() => {
    if (state._tag !== "Uploaded" || state.result.state !== "processing") return undefined;
    const timeout = setTimeout(() => {
      void inspect(state.result.fileId).then(
        (result) => {
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
        () => setState({ _tag: "Failed" }),
      );
    }, pollDelayMilliseconds);
    return () => clearTimeout(timeout);
  }, [inspect, pollDelayMilliseconds, state]);
  const upload = (file: File) => {
    const uploadId = makeUploadId();
    setState({ _tag: "Uploading", fileName: file.name });
    return void file
      .arrayBuffer()
      .then((buffer) => uploadFile(new Uint8Array(buffer), file.name, uploadId))
      .then(
        (result) => setState({ _tag: "Uploaded", result }),
        () => setState({ _tag: "Failed" }),
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
