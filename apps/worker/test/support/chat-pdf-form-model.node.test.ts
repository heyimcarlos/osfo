import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { ContentId } from "../../src/domain/client-content";
import { checkFileFieldEvidence } from "../../src/domain/file-evidence";
import { inspect } from "../../src/integrations/pdf/pdf-form";
import type { ResearchRequest } from "../emulators/provider-emulator";
import { create, digest } from "./chat-pdf-form-fixture";
import { respond } from "./chat-pdf-form-model";

const tools = [
  "readFile",
  "validateFileFields",
  "inspectPdfForm",
  "generateDocument",
  "loadSkill",
].map((name) => ({ function: { name } }));
const imageMessage = {
  role: "user",
  content:
    "Read the attached synthetic document. Report literal fields.\nOsfo attachment ingestion results:\nAttachment 1: owned File source-1 is ready. Read it with readFile.",
};
const formMessage = {
  role: "user",
  content:
    "Fill the attached synthetic application using the document I supplied. I choose Renewal and agree to contact.\nOsfo attachment ingestion results:\nAttachment 1: owned File template-1 is ready. Read it with readFile.",
};
const read = {
  _tag: "FileContentRead",
  fileId: "source-1",
  pages: [
    {
      page: 1,
      method: "ocr" as const,
      text: "Applicant name: Another Example\nDocument date: 04/03/2026\nExpiry date: not supplied",
    },
  ],
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const readMessage = { role: "tool", name: "readFile", content: encode(read) };
const Fields = Schema.Struct({
  fields: Schema.Array(
    Schema.Struct({
      field: Schema.String,
      candidates: Schema.Array(
        Schema.Struct({
          value: Schema.String,
          evidence: Schema.Array(Schema.Struct({ page: Schema.Int, quote: Schema.String })),
        }),
      ),
    }),
  ),
});

it.effect(
  "uses returned OCR quotes and form exports, then forwards the exact retained download URL",
  () =>
    Effect.gen(function* () {
      expect(respond({ messages: [imageMessage], tools })).toMatchObject({
        tool_calls: [{ name: "readFile", arguments: { fileId: "source-1" } }],
      });
      const validation = respond({ messages: [imageMessage, readMessage], tools });
      if (validation?.finish_reason !== "tool_calls")
        return yield* Effect.die(new Error("Expected validation tool call"));
      const requested = yield* Schema.decodeUnknownEffect(Fields)(
        validation.tool_calls[0]?.arguments,
      );
      const checked = {
        role: "tool",
        name: "validateFileFields",
        content: encode({
          _tag: "FileFieldsChecked",
          fileId: "source-1",
          fields: requested.fields.map((field) => checkFileFieldEvidence(read.pages, field)),
        }),
      };
      const history = [imageMessage, readMessage, checked];
      expect(respond({ messages: history, tools })).toMatchObject({
        response: expect.stringContaining("04/03/2026"),
      });
      expect(
        respond({
          messages: [...history, formMessage],
          tools: [{ function: { name: "loadSkill" } }],
        }),
      ).toMatchObject({ tool_calls: [{ name: "loadSkill" }] });
      expect(respond({ messages: [...history, formMessage], tools })).toMatchObject({
        tool_calls: [{ name: "inspectPdfForm", arguments: { fileId: "template-1" } }],
      });
      const fixture = yield* Effect.promise(create);
      const inspection = yield* inspect(ContentId.make("file:template-1"), fixture.template);
      const inspectedMessage = {
        role: "tool",
        name: "inspectPdfForm",
        content: encode({
          ...inspection,
          templateFileId: "template-1",
          templateDigest: digest(fixture.template),
        }),
      };
      const messages = [...history, formMessage, inspectedMessage];
      const generated = respond({ messages, tools });
      expect(generated).toMatchObject({
        tool_calls: [
          {
            name: "generateDocument",
            arguments: {
              source: {
                templateFileId: "template-1",
                templateDigest: digest(fixture.template),
                fields: [
                  { kind: "text", name: "ApplicantName", value: "Another Example" },
                  { kind: "text", name: "DocumentDateLiteral", value: "04/03/2026" },
                  { kind: "checkbox", name: "ContactPermission", value: "Agreed" },
                  { kind: "radio", name: "Service", value: "Renewal" },
                ],
              },
            },
          },
        ],
      });
      const continuation = {
        role: "user",
        content: "Continue your previous response from exactly where it left off.",
      };
      expect(respond({ messages: [...messages, continuation], tools })).toEqual(generated);
      const downloadUrl =
        "http://127.0.0.1:4173/documents/download?contentId=document%3AtoolCall%3Areal-result";
      const completed = {
        role: "tool",
        name: "generateDocument",
        content: encode({
          content: {
            contentId: "document:toolCall:real-result",
            sha256: "a".repeat(64),
            byteLength: 500,
            mediaType: "application/pdf",
          },
          downloadUrl,
        }),
      };
      expect(respond({ messages: [...messages, completed], tools })).toMatchObject({
        finish_reason: "stop",
        response: expect.stringContaining(downloadUrl),
      });
      expect(
        respond({
          messages: [...messages, completed, { role: "user", content: "What is the weather?" }],
          tools,
        }),
      ).toBeNull();
      return undefined;
    }),
);

it.effect("refuses missing owned media and mismatched returned File identities", () =>
  Effect.sync(() => {
    const missing: ResearchRequest = {
      messages: [{ role: "user", content: "Read the attached synthetic document." }],
      tools,
    };
    expect(
      respond({
        messages: [{ ...imageMessage, content: [{ type: "text", text: imageMessage.content }] }],
        tools,
      }),
    ).toEqual(respond({ messages: [imageMessage], tools }));
    expect(
      respond({
        messages: [{ role: "user", content: `${imageMessage.content}\nWhat is the weather?` }],
        tools,
      }),
    ).toBeNull();
    expect(respond(missing)).toMatchObject({
      finish_reason: "stop",
      response: expect.stringContaining("have not been read"),
    });
    expect(() =>
      respond({
        messages: [
          imageMessage,
          { ...readMessage, content: encode({ ...read, fileId: "other-owner-file" }) },
        ],
        tools,
      }),
    ).toThrow("different owned identity");
  }),
);
