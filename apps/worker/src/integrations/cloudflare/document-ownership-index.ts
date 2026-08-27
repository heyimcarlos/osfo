import { Result, Schema } from "effect";

import { UserId } from "../../domain";
import { ContentId } from "../../domain/client-content";
import { ownerKeyFor } from "./document-storage-keys";

/* oxlint-disable effecttsgo/async-function -- R2 is a Promise-based boundary owned by this adapter. */

const Metadata = Schema.fromJsonString(Schema.Struct({ contentId: ContentId, userId: UserId }));

/** Decode the production-owned User/document identity recorded by an ownership marker. */
export const decode = (object: { readonly customMetadata?: Readonly<Record<string, string>> }) =>
  Schema.decodeUnknownResult(Metadata)(object.customMetadata?.osfo);

/** Persist the User-scoped discovery marker before a document may create durable R2 state. */
export const ensure = async (bucket: R2Bucket, userId: UserId, contentId: ContentId) => {
  const key = ownerKeyFor(userId, contentId);
  const encoded = Schema.encodeSync(Metadata)({ contentId, userId });
  const created = await bucket.put(key, new Uint8Array(), {
    customMetadata: { osfo: encoded },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (created !== null) return;
  const existing = await bucket.head(key);
  if (existing === null) throw new Error("Generated-document ownership marker is missing");
  const metadata = decode(existing);
  if (
    Result.isFailure(metadata) ||
    metadata.success.contentId !== contentId ||
    metadata.success.userId !== userId
  ) {
    throw new Error("Generated-document ownership marker is invalid");
  }
};

export * as DocumentOwnershipIndex from "./document-ownership-index";
