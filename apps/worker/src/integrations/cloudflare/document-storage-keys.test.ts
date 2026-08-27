import { expect, it } from "@effect/vitest";

import { ContentId } from "../../domain/client-content";
import { UserId } from "../../domain";
import {
  artifactAttemptKeyFor,
  attemptKeyFor,
  attemptKeyForContentKey,
  contentKeyFor,
  contentKeyForAttemptKey,
  documentKeysForOwnerKey,
  ownerKeyFor,
} from "./document-storage-keys";

it("resolves only canonical Client Content body keys to attempt sidecars", () => {
  const contentId = ContentId.make("content-1");

  expect(attemptKeyForContentKey(contentKeyFor(contentId))).toBe(attemptKeyFor(contentId));
  expect(attemptKeyForContentKey("client-content/")).toBeUndefined();
  expect(attemptKeyForContentKey("client-content/not-hex")).toBeUndefined();
  expect(attemptKeyForContentKey("other/636f6e74656e742d31")).toBeUndefined();
});

it("routes generic artifact identities to their separate attempt namespace", () => {
  const userId = UserId.make("user-1");
  const contentId = ContentId.make("artifact:toolCall:presentation-1");
  const ownerKey = ownerKeyFor(userId, contentId);

  expect(attemptKeyForContentKey(contentKeyFor(contentId))).toBe(artifactAttemptKeyFor(contentId));
  expect(contentKeyForAttemptKey(artifactAttemptKeyFor(contentId))).toBe(contentKeyFor(contentId));
  expect(documentKeysForOwnerKey(userId, ownerKey)).toEqual({
    attemptKey: artifactAttemptKeyFor(contentId),
    contentKey: contentKeyFor(contentId),
    ownerKey,
  });
});

it("round-trips only canonical User-scoped document ownership keys", () => {
  const userId = UserId.make("user-1");
  const contentId = ContentId.make("content-1");
  const ownerKey = ownerKeyFor(userId, contentId);

  expect(contentKeyForAttemptKey(attemptKeyFor(contentId))).toBe(contentKeyFor(contentId));
  expect(documentKeysForOwnerKey(userId, ownerKey)).toEqual({
    attemptKey: attemptKeyFor(contentId),
    contentKey: contentKeyFor(contentId),
    ownerKey,
  });
  expect(documentKeysForOwnerKey(UserId.make("user-2"), ownerKey)).toBeUndefined();
  expect(documentKeysForOwnerKey(userId, `${ownerKey}z`)).toBeUndefined();
});
