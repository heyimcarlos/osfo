/* oxlint-disable effecttsgo/node-builtin-import -- The Node-only container acceptance test controls Docker fixtures outside the Worker runtime. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

const image = "osfo-file-task-vitest";
const taskPath = join(import.meta.dirname, "../src/integrations/cloudflare/file-task.py");

const TaskResult = Schema.Union([
  Schema.Struct({
    normalizedText: Schema.optional(Schema.String),
    ok: Schema.Literal(true),
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
          execFileSync("docker", ["build", "-t", image, "-f", "Dockerfile.files", "."], {
            cwd: join(import.meta.dirname, ".."),
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

const createFixture = (workspace: string, kind: "docx" | "image" | "malicious-docx" | "pdf") =>
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

const fixturePrograms = {
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
  maximumPdfPages: 500,
} as const;
