/* oxlint-disable effecttsgo/node-builtin-import -- The Node-only container acceptance test controls Docker fixtures outside the Worker runtime. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

const image = "osfo-file-task-vitest";
const taskPath = join(import.meta.dirname, "../src/integrations/cloudflare/file-task.txt");

const TaskResult = Schema.Union([
  Schema.Struct({
    normalizedText: Schema.optional(Schema.String),
    ok: Schema.Literal(true),
    pages: Schema.optional(
      Schema.Array(
        Schema.Struct({
          page: Schema.Finite,
          method: Schema.String,
          text: Schema.String,
        }),
      ),
    ),
    parser: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    message: Schema.String,
    ok: Schema.Literal(false),
    reason: Schema.Literals(["content_limit", "malicious", "parser_failure"]),
  }),
]);

describe("disposable Python file task", () => {
  it.effect("parses every supported media family and rejects bounded unsafe inputs", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "osfo-file-task-"))),
      (workspace) =>
        Effect.sync(() => {
          execFileSync("docker", ["build", "-t", image, "--target", "artifact-runtime", "."], {
            cwd: join(import.meta.dirname, "../document-sandbox"),
            stdio: "pipe",
          });
          writeFileSync(join(workspace, "file-task.py"), readFileSync(taskPath));

          writeFileSync(join(workspace, "source.bin"), "plain text");
          expect(runTask(workspace, "text/plain")).toMatchObject({ ok: true });

          writeFileSync(join(workspace, "source.bin"), "one,two\nthree,four\n");
          expect(runTask(workspace, "text/csv")).toMatchObject({ ok: true });

          createFixture(workspace, "pdf");
          expect(runTask(workspace, "application/pdf")).toMatchObject({ ok: true });

          createFixture(workspace, "docx");
          expect(
            runTask(
              workspace,
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
          ).toMatchObject({ ok: true });

          createFixture(workspace, "image");
          expect(runTask(workspace, "image/png")).toMatchObject({ ok: true });

          createFixture(workspace, "document-image");
          const imageResult = runTask(workspace, "image/png");
          expect(imageResult).toMatchObject({ ok: true, pages: [{ page: 1, method: "ocr" }] });
          if (!imageResult.ok) throw new Error("Synthetic image OCR failed");
          expect(imageResult.normalizedText).toContain("SAMPLE-4821");
          expect(imageResult.normalizedText).toContain("2030-06-30");
          expect(imageResult.normalizedText).not.toContain("Birth date");

          createFixture(workspace, "scanned-pdf");
          const scanResult = runTask(workspace, "application/pdf");
          expect(scanResult).toMatchObject({ ok: true, pages: [{ page: 1, method: "ocr" }] });
          if (!scanResult.ok) throw new Error("Synthetic scan OCR failed");
          expect(scanResult.normalizedText).toContain("SAMPLE-4821");
          expect(scanResult.normalizedText).toContain("2030-06-30");
          expect(runTask(workspace, "application/pdf", { maximumOcrPages: 0 })).toMatchObject({
            ok: false,
            reason: "content_limit",
          });

          createFixture(workspace, "native-pdf");
          expect(runTask(workspace, "application/pdf")).toMatchObject({
            ok: true,
            pages: [{ page: 1, method: "native_text", text: "Reference: NATIVE-913" }],
          });
          createFixture(workspace, "mixed-pdf");
          const mixedResult = runTask(workspace, "application/pdf");
          expect(mixedResult).toMatchObject({
            ok: true,
            pages: [{ page: 1, method: "native_text_and_ocr" }],
          });
          if (!mixedResult.ok) throw new Error("Synthetic mixed page OCR failed");
          expect(mixedResult.normalizedText).toContain("NATIVE-913");
          expect(mixedResult.normalizedText).toContain("SAMPLE-4821");

          createFixture(workspace, "pdf");
          expect(runTask(workspace, "application/pdf")).toMatchObject({
            ok: true,
            pages: [{ page: 1, method: "ocr", text: "" }],
          });
          expect(runTask(workspace, "application/pdf", { maximumPdfPages: 0 })).toMatchObject({
            ok: false,
            reason: "content_limit",
          });
          createFixture(workspace, "document-image");
          expect(runTask(workspace, "image/png", { maximumImagePixels: 100 })).toMatchObject({
            ok: false,
            reason: "malicious",
          });
          createFixture(workspace, "animated-image");
          expect(runTask(workspace, "image/gif")).toMatchObject({
            ok: false,
            reason: "content_limit",
          });

          writeFileSync(join(workspace, "source.bin"), "one\ntwo\n");
          expect(runTask(workspace, "text/csv", { maximumCsvRows: 1 })).toMatchObject({
            ok: false,
            reason: "content_limit",
          });

          writeFileSync(join(workspace, "source.bin"), Uint8Array.from([0xff, 0xfe]));
          expect(runTask(workspace, "text/plain")).toMatchObject({
            ok: false,
            reason: "parser_failure",
          });

          writeFileSync(join(workspace, "source.bin"), "a".repeat(2_000_001));
          expect(runTask(workspace, "text/plain")).toMatchObject({
            ok: false,
            reason: "content_limit",
          });

          createFixture(workspace, "malicious-docx");
          expect(
            runTask(
              workspace,
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
          ).toMatchObject({ ok: false, reason: "malicious" });
        }),
      (workspace) => Effect.sync(() => rmSync(workspace, { force: true, recursive: true })),
    ),
  );
});

const runTask = (
  workspace: string,
  mediaType: string,
  limitChanges: Partial<Record<keyof typeof limits, number>> = {},
) => {
  writeFileSync(
    join(workspace, "input.json"),
    JSON.stringify({
      limits: { ...limits, ...limitChanges },
      mediaType,
      operation: "normalize",
    }),
  );
  const execution = spawnSync("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "python3",
    "-v",
    `${workspace}:/workspace`,
    image,
    "/workspace/file-task.py",
  ]);
  expect([0, 1]).toContain(execution.status);
  return Schema.decodeSync(Schema.fromJsonString(TaskResult))(
    readFileSync(join(workspace, "result.json"), "utf8"),
  );
};

const createFixture = (workspace: string, kind: keyof typeof fixturePrograms) =>
  execFileSync("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "python3",
    "-v",
    `${workspace}:/workspace`,
    image,
    "-c",
    fixturePrograms[kind],
  ]);

const documentImage = `from PIL import Image, ImageDraw, ImageFont
im=Image.new('RGB',(1600,700),'white')
draw=ImageDraw.Draw(im)
font=ImageFont.load_default(size=44)
draw.multiline_text((80,100),'Document reference: SAMPLE-4821\\nValid until: 2030-06-30',font=font,fill='black',spacing=40)`;

const nativePdf = `from pypdf import PdfWriter, PdfReader
from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject
w=PdfWriter()
page=w.add_blank_page(800,350)
font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font})})
stream=DecodedStreamObject()
stream.set_data(b'BT /F1 16 Tf 30 30 Td (Reference: NATIVE-913) Tj ET')
page[NameObject('/Contents')]=stream`;

const fixturePrograms = {
  "document-image": `${documentImage}\nim.save('/workspace/source.bin','PNG')`,
  "scanned-pdf": `${documentImage}\nim.save('/workspace/source.bin','PDF',resolution=144)`,
  "native-pdf": `${nativePdf}\nw.write('/workspace/source.bin')`,
  "mixed-pdf": `${documentImage}\nim.save('/workspace/scanned.pdf','PDF',resolution=144)\n${nativePdf}\npage.merge_page(PdfReader('/workspace/scanned.pdf').pages[0])\nw.write('/workspace/source.bin')`,
  "animated-image":
    "from PIL import Image; a=Image.new('RGB',(30,30),'red'); b=Image.new('RGB',(30,30),'blue'); a.save('/workspace/source.bin','GIF',save_all=True,append_images=[b])",
  docx: "from docx import Document; d=Document(); d.add_paragraph('docx text'); d.save('/workspace/source.bin')",
  image: "from PIL import Image; Image.new('RGB',(2,2),'red').save('/workspace/source.bin','PNG')",
  "malicious-docx":
    "import zipfile; z=zipfile.ZipFile('/workspace/source.bin','w',zipfile.ZIP_DEFLATED); z.writestr('word/document.xml','A'*1000000); z.close()",
  pdf: "from pypdf import PdfWriter; w=PdfWriter(); w.add_blank_page(72,72); w.write('/workspace/source.bin')",
} as const;

const limits = {
  maximumCsvRows: 100_000,
  maximumImagePixels: 40_000_000,
  maximumNormalizedTextBytes: 2_000_000,
  maximumOfficeEntries: 10_000,
  maximumOcrPages: 10,
  maximumOcrImagePixels: 8_000_000,
  maximumPdfPages: 500,
} as const;
