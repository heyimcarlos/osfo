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
