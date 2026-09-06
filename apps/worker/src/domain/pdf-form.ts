import { Schema } from "effect";

import { FileId } from "./file";
import { FileDigest } from "./file-content";

const fieldName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const PdfFormFieldValue = Schema.Union([
  Schema.Struct({
    kind: Schema.tag("text"),
    name: fieldName,
    value: Schema.String.check(Schema.isMaxLength(1000)),
  }),
  Schema.Struct({
    kind: Schema.tag("checkbox"),
    name: fieldName,
    value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
  Schema.Struct({
    kind: Schema.tag("radio"),
    name: fieldName,
    value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
]);
export type PdfFormFieldValue = typeof PdfFormFieldValue.Type;

/** Exact edits to an immutable owned PDF. Omitted fields remain unchanged. */
export const PdfFormSource = Schema.Struct({
  templateFileId: FileId,
  templateDigest: FileDigest,
  pageCount: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(20)),
  fields: Schema.Array(PdfFormFieldValue).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type PdfFormSource = typeof PdfFormSource.Type;

/** Parser-observed labels and widget geometry, retained with the original file digest. */
export const PdfFormInspection = Schema.Struct({
  encrypted: Schema.Boolean,
  pageCount: PdfFormSource.fields.pageCount,
  fields: Schema.Array(
    Schema.Struct({
      name: fieldName,
      label: Schema.NullOr(Schema.String),
      currentValue: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
      kind: Schema.Literals(["text", "checkbox", "radio", "unsupported"]),
      restriction: Schema.NullOr(Schema.Literals(["is protected", "has no established purpose"])),
      exportValues: Schema.Array(Schema.String).check(Schema.isMaxLength(300)),
      widgets: Schema.Array(
        Schema.Struct({
          page: PdfFormSource.fields.pageCount,
          protectedRegion: Schema.NullOr(Schema.String),
          rect: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite]),
          labels: Schema.Array(
            Schema.Struct({
              text: Schema.String.check(Schema.isMaxLength(500)),
              x: Schema.Finite,
              y: Schema.Finite,
            }),
          ).check(Schema.isMaxLength(3)),
        }),
      ).check(Schema.isMaxLength(300)),
    }),
  ).check(Schema.isMaxLength(300)),
});
