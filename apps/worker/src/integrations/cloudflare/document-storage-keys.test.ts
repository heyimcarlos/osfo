import { expect, it } from "@effect/vitest";

import { ContentId } from "../../domain/client-content";
import { attemptKeyFor, attemptKeyForContentKey, contentKeyFor } from "./document-storage-keys";

it("resolves only canonical Client Content body keys to attempt sidecars", () => {
  const contentId = ContentId.make("content-1");

  expect(attemptKeyForContentKey(contentKeyFor(contentId))).toBe(attemptKeyFor(contentId));
  expect(attemptKeyForContentKey("client-content/")).toBeUndefined();
  expect(attemptKeyForContentKey("client-content/not-hex")).toBeUndefined();
  expect(attemptKeyForContentKey("other/636f6e74656e742d31")).toBeUndefined();
});
