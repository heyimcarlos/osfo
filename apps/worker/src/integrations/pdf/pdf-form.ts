import { Data, Effect } from "effect";
import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFHexString,
  type PDFField,
  PDFName,
  PDFRadioGroup,
  PDFSignature,
  PDFString,
  PDFTextField,
  StandardFonts,
} from "pdf-lib";

import type { ContentId } from "../../domain/client-content";
import { DocumentArtifact } from "../../domain/document-artifact";
import type { PdfFormSource } from "../../domain/pdf-form";

/** Fill existing widgets without flattening or regenerating untouched appearances. */
export const fill = (contentId: ContentId, bytes: Uint8Array, source: PdfFormSource) =>
  Effect.tryPromise({
    // oxlint-disable-next-line effecttsgo/async-function -- pdf-lib owns mutable PDF parsing and serialization.
    try: async () => {
      if (bytes.byteLength > DocumentArtifact.maximumDocumentBytes)
        throw new Error("Template exceeds PDF byte limit");
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      if (pdf.getPageCount() !== source.pageCount) throw new Error("Template page count changed");
      const form = pdf.getForm();
      if (form.hasXFA()) throw new Error("XFA forms are unsupported");
      const fields = form.getFields();
      const names = fields.map((field) => field.getName());
      if (new Set(names).size !== names.length) throw new Error("Ambiguous duplicate field names");
      if (new Set(source.fields.map((field) => field.name)).size !== source.fields.length)
        throw new Error("Duplicate field edits");
      const widgets = new Set(
        fields.flatMap((field) => field.acroField.getWidgets().map((widget) => widget.dict)),
      );
      for (const page of pdf.getPages()) {
        const annotations = page.node.Annots();
        if (annotations === undefined) continue;
        for (const ref of annotations.asArray()) {
          const annotation = pdf.context.lookup(ref);
          if (
            annotation instanceof PDFDict &&
            annotation.get(PDFName.of("Subtype")) === PDFName.of("Widget") &&
            !widgets.has(annotation)
          )
            throw new Error("Orphaned form widget");
        }
      }
      for (const field of fields) {
        if (
          field instanceof PDFSignature &&
          field.acroField.getInheritableAttribute(PDFName.of("V")) !== undefined
        )
          throw new Error("Signed PDFs cannot be rewritten");
      }
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      for (const edit of source.fields) {
        const field = form.getFieldMaybe(edit.name);
        if (field === undefined)
          throw new FormRejection({
            message: `Field "${edit.name}" is not present in the template`,
          });
        const restriction = fieldRestriction(field);
        if (restriction !== null)
          throw new FormRejection({
            message: `Field "${edit.name}" ${restriction}; leave it unchanged for review`,
          });
        if (edit.kind === "text" && field instanceof PDFTextField) {
          field.setText(edit.value);
          field.updateAppearances(font);
        } else if (edit.kind === "checkbox" && field instanceof PDFCheckBox) {
          const on = field.acroField.getOnValue();
          if (on === undefined || !["Off", on.decodeText()].includes(edit.value))
            throw new Error("Unknown checkbox export value");
          if (
            field.acroField
              .getWidgets()
              .some((widget) => widget.getOnValue()?.decodeText() !== on.decodeText())
          )
            throw new Error("Ambiguous checkbox exports");
          if (edit.value === "Off") field.uncheck();
          else field.check();
        } else if (edit.kind === "radio" && field instanceof PDFRadioGroup) {
          if (!field.getOptions().includes(edit.value))
            throw new Error("Unknown radio export value");
          field.select(edit.value);
        } else throw new Error("Unsupported field type");
      }
      const output = await pdf.save({ updateFieldAppearances: false });
      const reopened = await PDFDocument.load(output, { updateMetadata: false });
      const written = reopened.getForm();
      for (const edit of source.fields) {
        const field = written.getField(edit.name);
        if (
          edit.kind === "text" &&
          field instanceof PDFTextField &&
          (field.getText() ?? "") !== edit.value
        )
          throw new Error("Text value was not retained");
        if (
          edit.kind === "checkbox" &&
          field instanceof PDFCheckBox &&
          field.acroField.getValue().decodeText() !== edit.value
        )
          throw new Error("Checkbox value was not retained");
        if (
          edit.kind === "radio" &&
          field instanceof PDFRadioGroup &&
          field.getSelected() !== edit.value
        )
          throw new Error("Radio value was not retained");
        for (const widget of field.acroField.getWidgets()) {
          if (widget.getAppearances()?.normal === undefined)
            throw new Error("Missing widget appearance");
          if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
            const value = field.acroField.getValue();
            const expected = widget.getOnValue() === value ? value : PDFName.of("Off");
            if (widget.getAppearanceState() !== expected)
              throw new Error("Widget appearance disagrees with field value");
          }
        }
      }
      return { bytes: output, renderedPageCount: reopened.getPageCount() };
    },
    catch: (cause) =>
      new DocumentArtifact.InvalidGeneratedArtifact({
        contentId,
        reason: "invalidDocument",
        message:
          cause instanceof FormRejection
            ? cause.message
            : "The PDF form could not be filled without changing protected or unsupported fields",
      }),
  });

class FormRejection extends Data.TaggedError("FormRejection")<{ readonly message: string }> {}

/** Read exact form names and export values from owned bytes before proposing edits. */
export const inspect = (contentId: ContentId, bytes: Uint8Array) =>
  Effect.tryPromise({
    // oxlint-disable-next-line effecttsgo/async-function -- pdf-lib exposes a Promise parser.
    try: async () => {
      if (bytes.byteLength > DocumentArtifact.maximumDocumentBytes)
        throw new Error("Template exceeds PDF byte limit");
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      if (pdf.getPageCount() > DocumentArtifact.maximumDocumentPages)
        throw new Error("Template exceeds page limit");
      const form = pdf.getForm();
      if (form.hasXFA()) throw new Error("XFA forms are unsupported");
      const fields = form.getFields();
      if (fields.length > 300) throw new Error("Template exceeds field inspection limit");
      return {
        pageCount: pdf.getPageCount(),
        fields: fields.map((field) => ({
          name: field.getName(),
          label:
            field.acroField.dict
              .lookupMaybe(PDFName.of("TU"), PDFString, PDFHexString)
              ?.decodeText() ?? null,
          kind:
            field instanceof PDFTextField
              ? "text"
              : field instanceof PDFCheckBox
                ? "checkbox"
                : field instanceof PDFRadioGroup
                  ? "radio"
                  : "unsupported",
          restriction: fieldRestriction(field),
          exportValues:
            field instanceof PDFRadioGroup
              ? field.getOptions()
              : field instanceof PDFCheckBox
                ? ["Off", field.acroField.getOnValue()?.decodeText()].filter(
                    (value) => value !== undefined,
                  )
                : [],
        })),
      };
    },
    catch: () =>
      new DocumentArtifact.InvalidGeneratedArtifact({
        contentId,
        reason: "invalidDocument",
        message: "The owned PDF form cannot be safely inspected",
      }),
  });

const fieldRestriction = (field: PDFField) => {
  const alternative =
    field.acroField.dict.lookupMaybe(PDFName.of("TU"), PDFString, PDFHexString)?.decodeText() ?? "";
  const label = `${field.getName()} ${alternative}`;
  if (
    field.isReadOnly() ||
    field instanceof PDFSignature ||
    /signature|sign[ _-]?here|office|official|admin|staff|witness|certif/iu.test(label)
  )
    return "is protected";
  const words = label
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/u);
  if (
    !words.some((word) =>
      [
        "name",
        "address",
        "city",
        "province",
        "postal",
        "zip",
        "country",
        "phone",
        "email",
        "date",
        "birth",
        "contact",
        "language",
        "service",
        "consent",
        "applicant",
        "member",
        "citizenship",
        "residency",
        "gender",
        "marital",
        "occupation",
        "employer",
      ].includes(word),
    )
  )
    return "has no established purpose";
  if (
    !(
      field instanceof PDFTextField ||
      field instanceof PDFCheckBox ||
      field instanceof PDFRadioGroup
    )
  )
    return "has an unsupported field type";
  return null;
};

export * as PdfForm from "./pdf-form";
