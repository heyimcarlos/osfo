import { Schema } from "effect";

/** Stable server-issued identity of one immutable Client Content byte sequence. */
export const ContentId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(240),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
).pipe(Schema.brand("ContentId"));

/** Stable server-issued identity of one immutable Client Content byte sequence. */
export type ContentId = typeof ContentId.Type;

/** Client-safe reference to one immutable stored Client Content byte sequence. */
export const ClientContentRefV1 = Schema.Struct({
  byteLength: Schema.Int.check(Schema.isGreaterThan(0)),
  contentId: ContentId,
  mediaType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});

/** Client-safe reference to one immutable stored Client Content byte sequence. */
export type ClientContentRefV1 = typeof ClientContentRefV1.Type;
