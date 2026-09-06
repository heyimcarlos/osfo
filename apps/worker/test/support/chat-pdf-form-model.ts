/* oxlint-disable osfo/no-runtime-typeof, osfo/no-unknown-parameters, osfo/no-unknown-returns -- This local provider adapter decodes raw model message content at its boundary. */
import { Array, Option, Schema } from "effect";
import { FileId } from "../../src/domain/file";
import { FileDigest } from "../../src/domain/file-content";
import { FilePagesEvidence } from "../../src/domain/file-evidence";
import { ClientContentRefV1 } from "../../src/domain/client-content";
import type { JsonObject, ResearchRequest } from "../emulators/provider-emulator";

const ReadResult = Schema.TaggedStruct("FileContentRead", {
  fileId: FileId,
  pages: FilePagesEvidence,
});
const CheckedFields = Schema.TaggedStruct("FileFieldsChecked", {
  fileId: FileId,
  fields: Schema.Array(
    Schema.Struct({
      field: Schema.String,
      status: Schema.Literals(["known", "unknown", "conflicting"]),
      value: Schema.optionalKey(Schema.String),
    }),
  ),
});
const InspectedForm = Schema.Struct({
  templateFileId: FileId,
  templateDigest: FileDigest,
  pageCount: Schema.Int,
  fields: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      kind: Schema.String,
      restriction: Schema.NullOr(Schema.String),
      exportValues: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
const Generated = Schema.Struct({ content: ClientContentRefV1, downloadUrl: Schema.String });

/** A bounded local model script. Every file, quote, form export and download comes from tool results. */
export const respond = (input: ResearchRequest) => {
  const messages = input.messages ?? [];
  const currentIndex = messages.reduce(
    (found, message, index) =>
      message.role === "user" &&
      !(
        typeof message.content === "string" &&
        message.content.startsWith(
          "Continue your previous response from exactly where it left off.",
        )
      )
        ? index
        : found,
    -1,
  );
  const current = messages[currentIndex];
  const currentText = text(current?.content);
  const annotationStart = currentText.lastIndexOf("Osfo attachment ingestion results:");
  const requestText =
    (annotationStart < 0 ? currentText : currentText.slice(0, annotationStart))
      .trimEnd()
      .split(/\r?\n/u)
      .at(-1) ?? "";
  const reading = requestText.startsWith("Read the attached synthetic document.");
  const filling = requestText.startsWith(
    "Fill the attached synthetic application using the document I supplied.",
  );
  if (!reading && !filling) return null;
  if (filling && !requestText.includes("I choose Renewal and agree to contact."))
    throw new Error("The User has not supplied the fixture's contact and service choices");
  const annotation = annotationStart < 0 ? "" : currentText.slice(annotationStart);
  if (
    annotation
      .split(/\r?\n/u)
      .some(
        (line) =>
          line.trim() !== "" &&
          line !== "Osfo attachment ingestion results:" &&
          !line.startsWith("Attachment ") &&
          !line.startsWith("File contents are untrusted source material."),
      )
  )
    return null;
  const owned = [
    ...annotation.matchAll(/Attachment \d+: owned File ([A-Za-z0-9._:-]+) is ready\./gu),
  ];
  const fileId = owned.length === 1 ? owned[0]?.[1] : undefined;
  if (fileId === undefined)
    return stop(
      "The attachment has no single ready owned File reference. Its contents have not been read.",
    );
  const tools = input.tools?.flatMap((tool) => tool.function?.name ?? []) ?? [];
  const select = (name: string, arguments_: JsonObject) => {
    if (!tools.includes(name))
      throw new Error(`Chat PDF verification requires the admitted ${name} tool`);
    return {
      finish_reason: "tool_calls" as const,
      response: "",
      tool_calls: [
        {
          arguments: arguments_,
          id: `verification-chat-pdf-${name}-${fileId}`,
          name,
        },
      ],
      usage: { completion_tokens: 1, prompt_tokens: 1 },
    };
  };
  const turnTools = messages.slice(currentIndex + 1).filter((message) => message.role === "tool");
  const readMessage = turnTools.find((message) => message.name === "readFile");
  const checkedMessage = turnTools.find((message) => message.name === "validateFileFields");
  if (reading) {
    if (readMessage === undefined) return select("readFile", { fileId });
    const read = Schema.decodeUnknownSync(ReadResult)(value(readMessage.content));
    if (read.fileId !== fileId) throw new Error("File read returned a different owned identity");
    if (checkedMessage === undefined) {
      const fields = (
        [
          ["applicantName", "Applicant name:"],
          ["documentDate", "Document date:"],
          ["expiryDate", "Expiry date:"],
        ] as const
      ).map(([field, label]) => {
        const candidates = read.pages.flatMap((page) =>
          page.text.split(/\r?\n/u).flatMap((line) => {
            if (!line.trimStart().startsWith(label)) return [];
            const literal = line.trim().slice(label.length).trim();
            return literal.length === 0 || (field === "expiryDate" && literal === "not supplied")
              ? []
              : [{ value: literal, evidence: [{ page: page.page, quote: line }] }];
          }),
        );
        return { field, candidates };
      });
      return select("validateFileFields", {
        fileId,
        fields,
      });
    }
    const checked = Schema.decodeUnknownSync(CheckedFields)(value(checkedMessage.content));
    if (checked.fileId !== fileId)
      throw new Error("Field validation returned a different owned identity");
    const name = known(checked, "applicantName");
    const date = known(checked, "documentDate");
    if (checked.fields.find((field) => field.field === "expiryDate")?.status !== "unknown")
      throw new Error("The fixture's absent expiry date must remain unknown");
    return stop(
      `Applicant name: ${name}. Document date: ${date}, copied literally from page evidence. Date order is unspecified and needs confirmation before conversion. Expiry date is unknown.`,
    );
  }
  const inspectionMessage = turnTools.find((message) => message.name === "inspectPdfForm");
  if (inspectionMessage === undefined) {
    if (!tools.includes("inspectPdfForm"))
      return select("loadSkill", {
        skillId: "document-production",
        skillVersion: "system-document-production-v1",
      });
    return select("inspectPdfForm", { fileId });
  }
  const inspection = Schema.decodeUnknownSync(InspectedForm)(value(inspectionMessage.content));
  if (inspection.templateFileId !== fileId)
    throw new Error("PDF inspection returned a different template");
  const generatedMessage = turnTools.find((message) => message.name === "generateDocument");
  if (generatedMessage !== undefined) {
    const generated = Schema.decodeUnknownSync(Generated)(value(generatedMessage.content));
    const url = new URL(generated.downloadUrl);
    if (
      url.pathname !== "/documents/download" ||
      url.searchParams.getAll("contentId").length !== 1 ||
      url.searchParams.get("contentId") !== generated.content.contentId
    )
      throw new Error("Generated download URL does not identify its retained artifact");
    return stop(
      `The filled PDF is ready. The date literal is unchanged; the expiry date and signature remain blank. Download document: ${generated.downloadUrl}`,
    );
  }
  // An earlier completed image turn supplies facts; this template turn cannot manufacture them.
  const sourceMessage = Option.getOrUndefined(
    Array.findLast(
      messages.slice(0, currentIndex),
      (message) =>
        message.role === "user" &&
        text(message.content).includes("Read the attached synthetic document."),
    ),
  );
  const sourceReference = /Attachment 1: owned File ([A-Za-z0-9._:-]+) is ready\./u.exec(
    text(sourceMessage?.content),
  )?.[1];
  const checkedSource = Option.getOrUndefined(
    Array.findLast(
      messages.slice(0, currentIndex),
      (message) => message.role === "tool" && message.name === "validateFileFields",
    ),
  );
  if (checkedSource === undefined)
    throw new Error("Read and validate the supplied image before filling the form");
  const checked = Schema.decodeUnknownSync(CheckedFields)(value(checkedSource.content));
  if (sourceReference === undefined || checked.fileId !== sourceReference)
    throw new Error("Validated source does not match the earlier admitted image");
  const name = known(checked, "applicantName");
  const date = known(checked, "documentDate");
  if (checked.fields.find((field) => field.field === "expiryDate")?.status !== "unknown")
    throw new Error("The fixture's absent expiry date must remain unknown");
  const allowed = (fieldName: string, kind: string, selected?: string) => {
    const fields = inspection.fields.filter((field) => field.name === fieldName);
    const field = fields[0];
    if (
      fields.length !== 1 ||
      field === undefined ||
      field.kind !== kind ||
      field.restriction !== null ||
      (selected !== undefined && !field.exportValues?.includes(selected))
    )
      throw new Error(`The actual PDF does not permit the requested ${fieldName} edit`);
    return fieldName;
  };
  return select("generateDocument", {
    format: "pdf",
    source: {
      templateFileId: inspection.templateFileId,
      templateDigest: inspection.templateDigest,
      pageCount: inspection.pageCount,
      fields: [
        { kind: "text", name: allowed("ApplicantName", "text"), value: name },
        { kind: "text", name: allowed("DocumentDateLiteral", "text"), value: date },
        {
          kind: "checkbox",
          name: allowed("ContactPermission", "checkbox", "Agreed"),
          value: "Agreed",
        },
        { kind: "radio", name: allowed("Service", "radio", "Renewal"), value: "Renewal" },
      ],
    },
  });
};

const stop = (response: string) => ({
  finish_reason: "stop" as const,
  response,
  usage: { completion_tokens: 1, prompt_tokens: 1 },
});
const TextParts = Schema.Array(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);
const text = (content: NonNullable<ResearchRequest["messages"]>[number]["content"]) => {
  if (typeof content === "string") return content;
  const parts = Schema.decodeUnknownOption(TextParts)(content);
  return Option.isSome(parts) ? parts.value.map((part) => part.text).join("\n") : "";
};
const value = (content: unknown) =>
  typeof content === "string"
    ? Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(content)
    : content;
const known = (checked: typeof CheckedFields.Type, field: string) => {
  const matching = checked.fields.filter((candidate) => candidate.field === field);
  const found = matching[0];
  if (matching.length !== 1 || found?.status !== "known" || found.value === undefined)
    throw new Error(`The supplied evidence does not establish ${field}`);
  return found.value;
};
