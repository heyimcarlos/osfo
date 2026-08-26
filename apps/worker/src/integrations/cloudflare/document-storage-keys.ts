import type { UserId } from "../../domain";
import type { ContentId } from "../../domain/client-content";

export const encodedContentId = (contentId: ContentId) =>
  Array.from(new TextEncoder().encode(contentId), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/** Namespace for retained Client Content bodies and metadata. */
export const documentContentPrefix = "client-content/";

/** Namespace for durable document-attempt evidence. */
export const documentAttemptPrefix = "document-attempts/";

/** User-scoped namespace that makes generated-document ownership discoverable without a global scan. */
export const documentOwnerPrefix = "document-owners/by-user/";

/** Exact discovery prefix for generated documents owned by one User. */
export const ownerPrefixFor = (userId: UserId) =>
  `${documentOwnerPrefix}${encodeURIComponent(userId)}/`;

/** User-scoped ownership marker for one generated document. */
export const ownerKeyFor = (userId: UserId, contentId: ContentId) =>
  `${ownerPrefixFor(userId)}${encodedContentId(contentId)}`;

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

/** Resolve the retained Client Content body for a canonical attempt sidecar key. */
export const contentKeyForAttemptKey = (attemptKey: string) => {
  if (!attemptKey.startsWith(documentAttemptPrefix)) return undefined;
  const encodedId = attemptKey.slice(documentAttemptPrefix.length);
  return /^(?:[0-9a-f]{2})+$/u.test(encodedId) ? `${documentContentPrefix}${encodedId}` : undefined;
};

/** Resolve the exact body and attempt keys named by one User-scoped owner marker. */
export const documentKeysForOwnerKey = (userId: UserId, ownerKey: string) => {
  const prefix = ownerPrefixFor(userId);
  if (!ownerKey.startsWith(prefix)) return undefined;
  const encodedId = ownerKey.slice(prefix.length);
  if (!/^(?:[0-9a-f]{2})+$/u.test(encodedId)) return undefined;
  return {
    attemptKey: `${documentAttemptPrefix}${encodedId}`,
    contentKey: `${documentContentPrefix}${encodedId}`,
    ownerKey,
  };
};
