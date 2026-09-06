/** Browser route that preserves an owned document request through sign-in. */
export const documentDownloadPath = "/documents/download";

/** User-facing link for a retained document; the URL grants no access to its bytes. */
export const documentDownloadUrl = (contentId: string, webOrigin: string | URL) =>
  new URL(`${documentDownloadPath}?contentId=${encodeURIComponent(contentId)}`, webOrigin).href;

/** Existing byte endpoint rechecks the current authenticated owner on every download. */
export const documentExportUrl = (contentId: string, apiOrigin: string | URL) =>
  new URL(`/documents/export?contentId=${encodeURIComponent(contentId)}`, apiOrigin).href;
