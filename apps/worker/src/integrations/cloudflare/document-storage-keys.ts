import type { ContentId } from "../../domain/client-content";

const encodedContentId = (contentId: ContentId) =>
  Array.from(new TextEncoder().encode(contentId), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/** R2 key for one retained Client Content body and its trusted metadata. */
export const contentKeyFor = (contentId: ContentId) =>
  `client-content/${encodedContentId(contentId)}`;

/** R2 key for durable execution and incurred-cost identity evidence. */
export const attemptKeyFor = (contentId: ContentId) =>
  `document-attempts/${encodedContentId(contentId)}`;
