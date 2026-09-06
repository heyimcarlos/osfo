/* oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import -- This local verifier owns pdf-lib and filesystem Promise boundaries. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { ClientContentRefV1 } from "../../src/domain/client-content";
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";

export const facts = {
  applicantName: "Example Applicant",
  dateLiteral: "03/04/2026",
  contactPermission: "Agreed",
  service: "Renewal",
} as const;

export const edits = [
  { kind: "text", name: "ApplicantName", value: facts.applicantName },
  { kind: "text", name: "DocumentDateLiteral", value: facts.dateLiteral },
  { kind: "checkbox", name: "ContactPermission", value: facts.contactPermission },
  { kind: "radio", name: "Service", value: facts.service },
] as const;

export const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Synthetic source facts and blank interactive template. No filled result is authored here. */
export const create = async () => {
  const evidence = await PDFDocument.create();
  const evidencePage = evidence.addPage([600, 650]);
  evidencePage.drawText(
    [
      "Synthetic document for local verification",
      `Applicant name: ${facts.applicantName}`,
      `Document date: ${facts.dateLiteral}`,
      "Date order is unspecified. Confirm before converting.",
      "Expiry date: not supplied",
    ].join("\n"),
    { x: 40, y: 580, size: 18, lineHeight: 32 },
  );
  const template = await PDFDocument.create();
  const page = template.addPage([600, 750]);
  const font = await template.embedFont(StandardFonts.Helvetica);
  const form = template.getForm();
  form.acroForm.dict.set(PDFName.of("DR"), template.context.obj({ Font: { Helvetica: font.ref } }));
  page.drawText("Synthetic application form", { x: 40, y: 710, size: 20, font });
  for (const [name, y] of [
    ["ApplicantName", 650],
    ["DocumentDateLiteral", 585],
    ["UnknownDate", 520],
    ["OfficeUseOnly", 160],
    ["LockedReference", 95],
  ] as const) {
    page.drawText(name, { x: 40, y, size: 12, font });
    const field = form.createTextField(name);
    field.addToPage(page, { x: 210, y: y - 15, width: 330, height: 28, font });
    if (name === "OfficeUseOnly") field.setText("Reserved");
    if (name === "LockedReference") {
      field.setText("Retained");
      field.enableReadOnly();
    }
  }
  const checkbox = form.createCheckBox("ContactPermission");
  checkbox.addToPage(page, { x: 210, y: 435, width: 18, height: 18 });
  page.drawText("Contact permission", { x: 40, y: 440, size: 12, font });
  const checkboxAppearances = checkbox.acroField.getWidgets()[0]?.getAppearances();
  if (checkboxAppearances === undefined) throw new Error("Checkbox appearance is missing");
  for (const appearance of Object.values(checkboxAppearances)) {
    if (appearance === undefined) continue;
    if (!(appearance instanceof PDFDict)) throw new Error("Checkbox states are missing");
    const on = appearance.get(PDFName.of("Yes"));
    if (on === undefined) throw new Error("Checkbox on appearance is missing");
    appearance.set(PDFName.of("Agreed"), on);
    appearance.delete(PDFName.of("Yes"));
  }
  const radio = form.createRadioGroup("Service");
  radio.addOptionToPage("New", page, { x: 210, y: 365, width: 18, height: 18 });
  radio.addOptionToPage("Renewal", page, { x: 330, y: 365, width: 18, height: 18 });
  page.drawText("Service", { x: 40, y: 370, size: 12, font });
  page.drawText("New", { x: 235, y: 370, size: 12, font });
  page.drawText("Renewal", { x: 355, y: 370, size: 12, font });
  page.drawText("Office use only", { x: 40, y: 210, size: 16, font });
  const signature = template.context.register(
    template.context.obj({
      FT: "Sig",
      Type: "Annot",
      Subtype: "Widget",
      T: PDFString.of("ApplicantSignature"),
      Rect: [210, 275, 540, 305],
      P: page.ref,
    }),
  );
  form.acroForm.addField(signature);
  page.node.addAnnot(signature);
  page.drawText("Signature: leave blank", { x: 40, y: 290, size: 12, font });
  form.updateFieldAppearances(font);
  // pdf-lib uses numeric appearance exports by default; match the visible option labels.
  for (const [index, widget] of radio.acroField.getWidgets().entries()) {
    const option = radio.getOptions()[index];
    if (option === undefined) throw new Error("Radio option is missing");
    const appearances = widget.getAppearances();
    if (appearances === undefined) throw new Error("Radio appearance is missing");
    for (const appearance of Object.values(appearances)) {
      if (appearance === undefined) continue;
      if (!(appearance instanceof PDFDict)) throw new Error("Radio states are missing");
      const state = appearance.get(PDFName.of(String(index)));
      if (state === undefined) throw new Error("Radio on appearance is missing");
      appearance.set(PDFName.of(option), state);
      appearance.delete(PDFName.of(String(index)));
    }
  }
  return {
    evidence: await evidence.save(),
    template: await template.save({ updateFieldAppearances: false }),
  };
};

/** Inspect the downloaded bytes independently of the generating adapter's success response. */
export const inspectDownload = async (bytes: Uint8Array) => {
  if (bytes.byteLength === 0 || bytes.byteLength > 20_000_000)
    throw new Error("Downloaded PDF is empty or exceeds the verification bound");
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = pdf.getForm();
  const fields = form.getFields();
  const text = Object.fromEntries(
    ["ApplicantName", "DocumentDateLiteral", "UnknownDate", "OfficeUseOnly", "LockedReference"].map(
      (name) => [name, form.getTextField(name).getText() ?? ""],
    ),
  );
  const checkbox = form.getCheckBox("ContactPermission");
  const radio = form.getRadioGroup("Service");
  const checkboxStates = checkbox.acroField
    .getWidgets()
    .map((widget) => widget.getAppearanceState()?.decodeText());
  const radioStates = radio.acroField
    .getWidgets()
    .map((widget) => widget.getAppearanceState()?.decodeText());
  if (
    pdf.getPageCount() !== 1 ||
    fields.length !== 8 ||
    text.ApplicantName !== facts.applicantName ||
    text.DocumentDateLiteral !== facts.dateLiteral ||
    text.UnknownDate !== "" ||
    text.OfficeUseOnly !== "Reserved" ||
    text.LockedReference !== "Retained" ||
    !form.getTextField("LockedReference").isReadOnly() ||
    form.getField("ApplicantSignature").acroField.dict.has(PDFName.of("V")) ||
    checkbox.acroField.getValue().decodeText() !== "Agreed" ||
    checkboxStates.length !== 1 ||
    checkboxStates[0] !== "Agreed" ||
    radio.getSelected() !== "Renewal" ||
    radio.acroField.getValue().decodeText() !== "Renewal" ||
    radioStates.length !== 2 ||
    radioStates[0] !== "Off" ||
    radioStates[1] !== "Renewal" ||
    fields
      .flatMap((field) => field.acroField.getWidgets())
      .some(
        (widget) =>
          widget.getAppearances()?.normal === undefined &&
          widget.dict.get(PDFName.of("FT")) !== PDFName.of("Sig"),
      )
  )
    throw new Error(
      "Downloaded form differs from supplied facts or protected fields; keep evidence incomplete",
    );
  return {
    sha256: digest(bytes).slice(7),
    byteLength: bytes.byteLength,
    pageCount: 1,
    text,
    checkboxStates,
    radioStates,
    signatureBlank: true,
  };
};

const retainedReference = Schema.Struct({
  content: ClientContentRefV1,
  downloadUrl: Schema.String,
});

if (import.meta.main) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const [command, directory, downloadedPath, referencePath, webOrigin] = process.argv.slice(2);
      if (directory === undefined)
        return yield* Effect.die(
          new Error(
            "Expected prepare <directory> or inspect <directory> <browser-download> <generated-result.json> <web-origin>",
          ),
        );
      if (command === "prepare") {
        const fixture = yield* Effect.promise(create);
        const manifest = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          facts,
          edits,
          evidenceSha256: digest(fixture.evidence),
          templateSha256: digest(fixture.template),
        });
        yield* Effect.promise(() => mkdir(directory, { recursive: true }));
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(join(directory, "evidence.pdf"), fixture.evidence),
            writeFile(join(directory, "template.pdf"), fixture.template),
            writeFile(join(directory, "fixture.json"), manifest),
          ]),
        );
        return undefined;
      }
      if (
        command !== "inspect" ||
        downloadedPath === undefined ||
        referencePath === undefined ||
        webOrigin === undefined
      )
        return yield* Effect.die(
          new Error(
            "Expected inspect <directory> <browser-download> <generated-result.json> <web-origin>",
          ),
        );
      const referenceText = yield* Effect.promise(() => readFile(referencePath, "utf8"));
      const reference = yield* Schema.decodeEffect(Schema.fromJsonString(retainedReference))(
        referenceText,
      );
      if (!URL.canParse(reference.downloadUrl))
        return yield* Effect.die(new Error("Generated result has no valid download URL"));
      const downloadUrl = new URL(reference.downloadUrl);
      if (
        reference.content.mediaType !== "application/pdf" ||
        downloadUrl.origin !== webOrigin ||
        downloadUrl.pathname !== "/documents/download" ||
        downloadUrl.searchParams.getAll("contentId").length !== 1 ||
        downloadUrl.searchParams.get("contentId") !== reference.content.contentId
      )
        return yield* Effect.die(
          new Error("Download URL does not identify the exact generated artifact on this run"),
        );
      const bytes = yield* Effect.promise(() => readFile(downloadedPath));
      const result = yield* Effect.promise(() => inspectDownload(bytes));
      if (
        result.sha256 !== reference.content.sha256 ||
        result.byteLength !== reference.content.byteLength
      )
        return yield* Effect.die(
          new Error("Browser download does not match retained artifact digest and byte length"),
        );
      const inspection = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        ...result,
        contentId: reference.content.contentId,
        downloadUrl: reference.downloadUrl,
        browserDownloadPath: downloadedPath,
        proof: "artifact-bytes-only",
      });
      yield* Effect.promise(() =>
        writeFile(join(directory, "download-inspection.json"), inspection),
      );
      return undefined;
    }),
  );
}
