import { documentExportUrl } from "@osfo/api/document-download";
import { Link, useSearch } from "@tanstack/react-router";
import { Download, FileText } from "lucide-react";

import { apiBaseURL } from "../config";

/** The authenticated byte endpoint remains the authority for this document's ownership. */
export function DocumentDownloadPage() {
  const { contentId } = useSearch({ from: "/authenticated/documents/download" });
  return (
    <main className="grid min-h-dvh place-items-center bg-[#f4f7fc] px-4 py-10 text-[#101936]">
      <section className="w-full max-w-md rounded-2xl border border-[#dce7f7] bg-white p-6 shadow-sm">
        <FileText aria-hidden="true" className="mb-4 size-8 text-[#2568ca]" />
        <h1 className="text-xl font-semibold">Download your document</h1>
        {contentId === undefined ? (
          <p role="alert" className="mt-3 text-sm text-[#687896]">
            This document link is incomplete. Open the link Osfo sent in your conversation.
          </p>
        ) : (
          <>
            <p className="mt-3 text-sm text-[#687896]">
              Use the same Osfo account that requested the document. Access is checked when you
              download.
            </p>
            <a
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#2568ca] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1e56a8]"
              href={documentExportUrl(contentId, apiBaseURL)}
            >
              <Download aria-hidden="true" className="size-4" />
              Download document
            </a>
          </>
        )}
        <p className="mt-6 text-sm">
          <Link className="text-[#2568ca] hover:underline" to="/settings">
            Back to your agent
          </Link>
        </p>
      </section>
    </main>
  );
}
