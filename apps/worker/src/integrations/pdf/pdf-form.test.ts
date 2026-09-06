/* oxlint-disable effecttsgo/async-function, vitest/no-standalone-expect -- pdf-lib authoring is a Promise boundary; assertions run inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { ContentId } from "../../domain/client-content";
import { FileId } from "../../domain/file";
import { FileDigest } from "../../domain/file-content";
import type { PdfFormSource } from "../../domain/pdf-form";
import { fill, inspect } from "./pdf-form";

const contentId = ContentId.make("document:toolCall:form-test");
const source = {
  templateFileId: FileId.make("form-template"),
  templateDigest: FileDigest.make(`sha256:${"a".repeat(64)}`),
  pageCount: 1,
  fields: [
    { kind: "text", name: "ApplicantName", value: "Example Applicant" },
    { kind: "checkbox", name: "ContactPermission", value: "Agreed" },
    { kind: "radio", name: "Service", value: "Renewal" },
  ],
} satisfies PdfFormSource;

it.effect("retains canonical fields and exact export appearances", () =>
  Effect.gen(function* () {
    const bytes = yield* Effect.promise(makeFixture);
    const result = yield* fill(contentId, bytes, source);
    const pdf = yield* Effect.promise(() => PDFDocument.load(result.bytes));
    const form = pdf.getForm();
    expect(form.getTextField("ApplicantName").getText()).toBe("Example Applicant");
    const checkbox = form.getCheckBox("ContactPermission");
    expect(checkbox.acroField.getValue().decodeText()).toBe("Agreed");
    expect(
      checkbox.acroField.getWidgets().map((w) => w.getAppearanceState()?.decodeText()),
    ).toEqual(["Agreed"]);
    const radio = form.getRadioGroup("Service");
    expect(radio.getSelected()).toBe("Renewal");
    expect(radio.acroField.getValue().decodeText()).toBe("1");
    expect(radio.acroField.getWidgets().map((w) => w.getAppearanceState()?.decodeText())).toEqual([
      "Off",
      "1",
    ]);
    expect(form.getTextField("UnknownDate").getText()).toBeUndefined();
    expect(form.getTextField("OfficeUseOnly").getText()).toBe("Reserved");
    expect(form.getTextField("LockedReference").getText()).toBe("Retained");
    expect(form.getField("ApplicantSignature").acroField.dict.has(PDFName.of("V"))).toBe(false);
    expect(form.getFields()).toHaveLength(9);
    expect(
      form
        .getTextField("ApplicantName")
        .acroField.getWidgets()
        .every((w) => w.getAppearances()?.normal !== undefined),
    ).toBe(true);
  }),
);

it.effect("inspects exact exports and marks opaque fields for review", () =>
  Effect.gen(function* () {
    const bytes = yield* Effect.promise(makeFixture);
    const result = yield* inspect(contentId, bytes);
    expect(result.fields).toContainEqual({
      name: "ContactPermission",
      label: null,
      kind: "checkbox",
      restriction: null,
      exportValues: ["Off", "Agreed"],
    });
    expect(result.fields).toContainEqual({
      name: "Service",
      label: null,
      kind: "radio",
      restriction: null,
      exportValues: ["New", "Renewal"],
    });
    expect(result.fields.find((field) => field.name === "Update")?.restriction).toBe(
      "has no established purpose",
    );
    expect(result.fields.find((field) => field.name === "ApplicantSignature")?.restriction).toBe(
      "is protected",
    );
  }),
);

it.effect("rejects hybrid XFA forms before pdf-lib can remove their data", () =>
  Effect.gen(function* () {
    const bytes = yield* Effect.promise(makeFixture);
    const pdf = yield* Effect.promise(() => PDFDocument.load(bytes));
    pdf.getForm().acroForm.dict.set(PDFName.of("XFA"), PDFString.of("<xfa>retained</xfa>"));
    const hybrid = yield* Effect.promise(() => pdf.save({ updateFieldAppearances: false }));
    expect(yield* inspect(contentId, hybrid).pipe(Effect.result)).toMatchObject({
      failure: { _tag: "InvalidGeneratedArtifact" },
    });
    expect(yield* fill(contentId, hybrid, source).pipe(Effect.result)).toMatchObject({
      failure: { _tag: "InvalidGeneratedArtifact" },
    });
    const retained = yield* Effect.promise(() => PDFDocument.load(hybrid));
    expect(retained.catalog.lookup(PDFName.of("AcroForm"), PDFDict).has(PDFName.of("XFA"))).toBe(
      true,
    );
  }),
);

it.effect("rejects a signed template before changing any field", () =>
  Effect.gen(function* () {
    const bytes = yield* Effect.promise(makeFixture);
    const pdf = yield* Effect.promise(() => PDFDocument.load(bytes));
    pdf
      .getForm()
      .getField("ApplicantSignature")
      .acroField.dict.set(PDFName.of("V"), pdf.context.obj({ Type: "Sig" }));
    const signed = yield* Effect.promise(() => pdf.save({ updateFieldAppearances: false }));
    expect(yield* fill(contentId, signed, source).pipe(Effect.result)).toMatchObject({
      failure: { _tag: "InvalidGeneratedArtifact" },
    });
  }),
);

for (const edit of [
  { kind: "text", name: "NotPresent", value: "Guess" },
  { kind: "text", name: "Update", value: "Guess" },
  { kind: "text", name: "Capacity", value: "Guess" },
  { kind: "text", name: "OfficeUseOnly", value: "Override" },
  { kind: "text", name: "LockedReference", value: "Override" },
  { kind: "text", name: "ApplicantSignature", value: "Signature" },
  { kind: "checkbox", name: "ContactPermission", value: "Yes" },
  { kind: "radio", name: "Service", value: "1" },
] as const)
  it.effect(`rejects ${edit.name}:${edit.value}`, () =>
    Effect.gen(function* () {
      const bytes = yield* Effect.promise(makeFixture);
      expect(
        yield* fill(contentId, bytes, { ...source, fields: [edit] }).pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "InvalidGeneratedArtifact" } });
    }),
  );

const makeFixture = async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 650]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const form = pdf.getForm();
  page.drawText("Synthetic application form", { x: 40, y: 605, size: 20, font });
  for (const [index, name] of [
    "ApplicantName",
    "UnknownDate",
    "OfficeUseOnly",
    "LockedReference",
  ].entries()) {
    page.drawText(name, { x: 40, y: 550 - index * 70, size: 12, font });
    const field = form.createTextField(name);
    field.addToPage(page, { x: 210, y: 535 - index * 70, width: 330, height: 28, font });
    if (name === "OfficeUseOnly") field.setText("Reserved");
    if (name === "LockedReference") {
      field.setText("Retained");
      field.enableReadOnly();
    }
  }
  const checkbox = form.createCheckBox("ContactPermission");
  checkbox.addToPage(page, { x: 210, y: 242, width: 18, height: 18 });
  page.drawText("Contact permission", { x: 40, y: 250, size: 12, font });
  const widget = checkbox.acroField.getWidgets()[0];
  if (widget === undefined) throw Error("Missing widget");
  const normal = widget.getAppearances()?.normal;
  if (!(normal instanceof PDFDict)) throw Error("Missing appearance");
  const appearance = normal.get(PDFName.of("Yes"));
  if (appearance === undefined) throw Error("Missing on state");
  normal.set(PDFName.of("Agreed"), appearance);
  normal.delete(PDFName.of("Yes"));
  const radio = form.createRadioGroup("Service");
  radio.addOptionToPage("New", page, { x: 210, y: 190, width: 18, height: 18 });
  radio.addOptionToPage("Renewal", page, { x: 330, y: 190, width: 18, height: 18 });
  page.drawText("New", { x: 240, y: 190, size: 12, font });
  page.drawText("Renewal", { x: 360, y: 190, size: 12, font });
  form.createTextField("Update");
  form.createTextField("Capacity");
  page.drawText("Signature: leave blank", { x: 40, y: 110, size: 12, font });
  page.drawLine({ start: { x: 210, y: 95 }, end: { x: 540, y: 95 } });
  const signature = pdf.context.register(
    pdf.context.obj({
      FT: "Sig",
      Type: "Annot",
      Subtype: "Widget",
      T: PDFString.of("ApplicantSignature"),
      Rect: [210, 80, 540, 110],
      P: page.ref,
    }),
  );
  form.acroForm.addField(signature);
  page.node.addAnnot(signature);
  form.updateFieldAppearances(font);
  return pdf.save({ updateFieldAppearances: false });
};
