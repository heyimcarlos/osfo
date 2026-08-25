import type { ContentId } from "../../domain/client-content";

const encodedContentId = (contentId: ContentId) =>
  Array.from(new TextEncoder().encode(contentId), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/** Namespace for retained Client Content bodies and metadata. */
export const documentContentPrefix = "client-content/";

/** Namespace for durable document-attempt evidence. */
export const documentAttemptPrefix = "document-attempts/";

/** R2 key for one retained Client Content body and its trusted metadata. */
export const contentKeyFor = (contentId: ContentId) =>
  `${documentContentPrefix}${encodedContentId(contentId)}`;

/** R2 key for durable execution and incurred-cost identity evidence. */
export const attemptKeyFor = (contentId: ContentId) =>
  `${documentAttemptPrefix}${encodedContentId(contentId)}`;

/** Resolve the attempt sidecar for a valid retained Client Content body key. */
export const attemptKeyForContentKey = (contentKey: string) => {
  if (!contentKey.startsWith(documentContentPrefix)) return undefined;
  const encodedId = contentKey.slice(documentContentPrefix.length);
  return /^(?:[0-9a-f]{2})+$/u.test(encodedId) ? `${documentAttemptPrefix}${encodedId}` : undefined;
};
