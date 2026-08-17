import { describe, expect, it } from "@effect/vitest";
import { PDFDocument } from "pdf-lib";
import { Effect, Schema } from "effect";
import { strToU8, zipSync } from "fflate";

import { AllowancePeriodId, PlanPolicyVersion, UserId } from "../src/domain";
import { ActionId } from "../src/domain/action-execution";
import { AuthSessionId } from "../src/domain/auth-session";
import { retainedCatalog } from "../src/domain/plan-policy";
import * as DocumentGeneration from "../src/services/document-generation";
import { make as makeAuthorization } from "../src/services/authorization";

/* oxlint-disable eslint/no-underscore-dangle -- Test fixtures use domain discriminators. */

describe("Document Generation", () => {
  it.effect("returns one validated PDF artifact with stable export metadata", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const fixture = makeFixture({
        computeResult: {
          _tag: "Completed",
          bytes: pdf,
          cost: {
            _tag: "Incurred",
            basis: "observed",
            providerOperationId: "provider-pdf-1",
            usdMicros: 12_345n,
          },
          renderedPageCount: 1,
        },
      });

      const artifact = yield* fixture.documents.generate(generationRequest("pdf"));

      expect(artifact).toMatchObject({
        artifactId: "toolCall:tool-call-176",
        byteLength: pdf.byteLength,
        mediaType: "application/pdf",
        pageCount: 1,
      });
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(fixture.stored).toHaveLength(1);
      expect(fixture.recorded).toEqual([
        {
          allowancePeriodId: AllowancePeriodId.make("allowance-period-176"),
          items: [{ allowanceKind: "vendorUsdMicros", basis: "observed", quantity: 12_345n }],
          source: { sourceId: "provider-pdf-1", sourceType: "documentProviderOperation" },
        },
        {
          allowancePeriodId: AllowancePeriodId.make("allowance-period-176"),
          items: [{ allowanceKind: "generatedDocuments", basis: "observed", quantity: 1n }],
          source: { sourceId: "tool-call-176", sourceType: "toolCall" },
        },
      ]);
    }),
  );

  it.effect("returns one validated DOCX artifact with its embedded page count", () =>
    Effect.gen(function* () {
      const docx = makeDocx(2);
      const fixture = makeFixture({
        computeResult: {
          _tag: "Completed",
          bytes: docx,
          cost: { _tag: "ProvenNoUse" },
          renderedPageCount: 2,
        },
      });

      const artifact = yield* fixture.documents.generate({
        ...generationRequest("docx"),
        source: DocumentGeneration.DocumentSource.make({
          pages: [
            { lines: ["First page"], title: "Issue 176" },
            { lines: ["Second page"], title: "Issue 176" },
          ],
        }),
      });

      expect(artifact).toMatchObject({
        artifactId: "toolCall:tool-call-176",
        byteLength: docx.byteLength,
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        pageCount: 2,
      });
    }),
  );

  it.effect("rejects artifacts above the page and byte limits", () =>
    Effect.gen(function* () {
      const oversizedPdf = yield* Effect.promise(() => makePdf(21));
      const pageFixture = makeFixture({
        computeResult: completed(oversizedPdf),
      });
      const byteFixture = makeFixture({
        computeResult: completed(new Uint8Array(5_000_001)),
      });

      const pageError = yield* pageFixture.documents
        .generate(generationRequest("pdf"))
        .pipe(Effect.flip);
      const byteError = yield* byteFixture.documents
        .generate(generationRequest("pdf"))
        .pipe(Effect.flip);

      expect(pageError).toMatchObject({ _tag: "InvalidGeneratedArtifact", reason: "pageLimit" });
      expect(byteError).toMatchObject({ _tag: "InvalidGeneratedArtifact", reason: "byteLimit" });
      expect(pageFixture.stored).toHaveLength(0);
      expect(byteFixture.stored).toHaveLength(0);
    }),
  );

  it.effect("rejects invalid output and records no completed document", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ computeResult: completed(strToU8("not a pdf")) });

      const error = yield* fixture.documents.generate(generationRequest("pdf")).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "InvalidGeneratedArtifact",
        reason: "invalidDocument",
      });
      expect(fixture.recorded).toHaveLength(0);
      expect(fixture.stored).toHaveLength(0);
    }),
  );

  it.effect("records incurred cost but no document after interrupted compute", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        computeResult: {
          _tag: "Interrupted",
          cost: {
            _tag: "Incurred",
            basis: "conservative",
            providerOperationId: "provider-interrupted-1",
            usdMicros: 50_000n,
          },
          evidence: "The isolated process ended before export",
        },
      });

      const error = yield* fixture.documents.generate(generationRequest("pdf")).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "DocumentComputeInterrupted" });
      expect(fixture.recorded).toEqual([
        {
          allowancePeriodId,
          items: [{ allowanceKind: "vendorUsdMicros", basis: "conservative", quantity: 50_000n }],
          source: {
            sourceId: "provider-interrupted-1",
            sourceType: "documentProviderOperation",
          },
        },
      ]);
      expect(fixture.stored).toHaveLength(0);
    }),
  );

  it.effect("returns the retained artifact on safe retry without running compute again", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const fixture = makeFixture({ computeResult: completed(pdf) });

      const first = yield* fixture.documents.generate(generationRequest("pdf"));
      const retried = yield* fixture.documents.generate(generationRequest("pdf"));

      expect(retried).toEqual(first);
      expect(fixture.computeCalls()).toBe(1);
      expect(fixture.stored).toHaveLength(1);
    }),
  );

  it.effect("rejects a changed intent under the same owning identity", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const fixture = makeFixture({ computeResult: completed(pdf) });
      const request = generationRequest("pdf");
      yield* fixture.documents.generate(request);

      const error = yield* fixture.documents
        .generate({
          ...request,
          source: DocumentGeneration.DocumentSource.make({
            pages: [{ lines: ["Changed content"], title: "Changed intent" }],
          }),
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "DocumentIntentConflict" });
      expect(fixture.computeCalls()).toBe(1);
    }),
  );

  it.effect(
    "records truth but rejects output when observed cost exceeds the admitted maximum",
    () =>
      Effect.gen(function* () {
        const pdf = yield* Effect.promise(() => makePdf(1));
        const fixture = makeFixture({
          computeResult: {
            _tag: "Completed",
            bytes: pdf,
            cost: {
              _tag: "Incurred",
              basis: "observed",
              providerOperationId: "provider-cost-overrun",
              usdMicros: 50_001n,
            },
            renderedPageCount: 1,
          },
        });

        const error = yield* fixture.documents.generate(generationRequest("pdf")).pipe(Effect.flip);

        expect(error).toMatchObject({ _tag: "DocumentCostLimitExceeded" });
        expect(fixture.recorded).toHaveLength(1);
        expect(fixture.stored).toHaveLength(0);
      }),
  );

  it.effect("deletes the retained artifact", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const fixture = makeFixture({ computeResult: completed(pdf) });
      const artifact = yield* fixture.documents.generate(generationRequest("pdf"));

      yield* fixture.documents.delete({
        actionId: ActionId.make("delete-176"),
        artifactId: artifact.artifactId,
        authorization: artifactAuthorization("delete-176", "file.delete"),
      });

      expect(fixture.stored).toHaveLength(0);
    }),
  );

  it.effect("exports verified bytes only to the owning User", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const fixture = makeFixture({ computeResult: completed(pdf) });
      const artifact = yield* fixture.documents.generate(generationRequest("pdf"));

      const exported = yield* fixture.documents.export({
        actionId: ActionId.make("export-176"),
        artifactId: artifact.artifactId,
        authorization: artifactAuthorization("export-176", "document.read"),
      });
      const denied = yield* fixture.documents
        .export({
          actionId: ActionId.make("foreign-export-176"),
          artifactId: artifact.artifactId,
          authorization: foreignAuthorization("foreign-export-176"),
        })
        .pipe(Effect.flip);

      expect(exported).toEqual({ artifact, bytes: pdf });
      expect(denied).toMatchObject({ _tag: "Denied", reason: "ownershipRequired" });
    }),
  );

  it.effect("rejects forged DOCX page metadata", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ computeResult: completed(makeDocx(2, 0)) });

      const error = yield* fixture.documents
        .generate({
          ...generationRequest("docx"),
          source: DocumentGeneration.DocumentSource.make({
            pages: [
              { lines: [], title: "One" },
              { lines: [], title: "Two" },
            ],
          }),
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "InvalidGeneratedArtifact" });
    }),
  );

  it.effect("denies Free generation before disposable compute", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const fixture = makeFixture({ computeResult: completed(pdf) });
      const request = generationRequest("pdf");

      const error = yield* fixture.documents
        .generate({
          ...request,
          authorization: {
            ...request.authorization,
            allowance: {
              _tag: "Metered",
              allowancePeriodId,
              endsAt: date("2026-09-01T00:00:00.000Z"),
              plan: "free",
              planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
              startsAt: date("2026-08-01T00:00:00.000Z"),
              usage: [],
            },
            subscription: { ...request.authorization.subscription, plan: "free" },
          },
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "Denied", reason: "missingEntitlement" });
      expect(fixture.computeCalls()).toBe(0);
    }),
  );

  it.effect("denies retained document export after downgrade to Free", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const fixture = makeFixture({ computeResult: completed(pdf) });
      const artifact = yield* fixture.documents.generate(generationRequest("pdf"));
      const authorization = artifactAuthorization("free-export-176", "document.read");

      const error = yield* fixture.documents
        .export({
          actionId: ActionId.make("free-export-176"),
          artifactId: artifact.artifactId,
          authorization: {
            ...authorization,
            allowance: {
              _tag: "Metered",
              allowancePeriodId,
              endsAt: date("2026-09-01T00:00:00.000Z"),
              plan: "free",
              planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
              startsAt: date("2026-08-01T00:00:00.000Z"),
              usage: [],
            },
            subscription: { ...authorization.subscription, plan: "free" },
          },
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "Denied", reason: "missingEntitlement" });
    }),
  );
});

const userId = UserId.make("user-176");
const allowancePeriodId = AllowancePeriodId.make("allowance-period-176");

const generationRequest = (format: "pdf" | "docx"): DocumentGeneration.GenerateRequest => ({
  actionId: ActionId.make("tool-call-176"),
  authorization: {
    allowance: {
      _tag: "Metered",
      allowancePeriodId,
      endsAt: date("2026-09-01T00:00:00.000Z"),
      plan: "adventurer",
      planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
      startsAt: date("2026-08-01T00:00:00.000Z"),
      usage: [],
    },
    approval: null,
    authority: {
      _tag: "DurableTrigger",
      triggerId: "workflow-176",
      triggerType: "workflow",
      userId,
    },
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    gmailConnection: null,
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentWorkflows: 1n,
      retainedFileBytes: 0n,
    },
    now: date("2026-08-17T12:00:00.000Z"),
    originatingAuthority: {
      _tag: "DurableTrigger",
      triggerId: "workflow-176",
      triggerType: "workflow",
    },
    requestVendorUsdMicros: 50_000n,
    resourceOwnerUserId: userId,
    subscription: {
      plan: "adventurer",
      planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    },
    user: { _tag: "ActiveUser", userId },
  },
  format,
  owner: { _tag: "ToolCall", toolCallId: "tool-call-176" },
  source: DocumentGeneration.DocumentSource.make({
    pages: [{ lines: ["Bounded document content"], title: "Issue 176" }],
  }),
});

const artifactAuthorization = (actionId: string, operation: "document.read" | "file.delete") => {
  const base = generationRequest("pdf").authorization;
  const authSessionId = AuthSessionId.make("session-176");
  return {
    ...base,
    approval: operation === "file.delete" ? { actionId, operation, userId } : null,
    authority: {
      _tag: "AuthSession" as const,
      authSessionId,
      expiresAt: date("2026-09-01T00:00:00.000Z"),
      userId,
    },
    originatingAuthority: { _tag: "AuthSession" as const, authSessionId },
  };
};

const foreignAuthorization = (actionId: string) => {
  const foreignUserId = UserId.make("another-user");
  const authorization = artifactAuthorization(actionId, "document.read");
  if (authorization.authority._tag !== "AuthSession") return authorization;
  return {
    ...authorization,
    authority: { ...authorization.authority, userId: foreignUserId },
    user: { _tag: "ActiveUser" as const, userId: foreignUserId },
  };
};

const makeFixture = (options: { readonly computeResult: DocumentGeneration.ComputeResult }) => {
  let computeCalls = 0;
  const stored: Array<DocumentGeneration.StoredArtifact> = [];
  const recorded: Array<{
    readonly allowancePeriodId: AllowancePeriodId;
    readonly items: ReadonlyArray<DocumentGeneration.AllowanceItem>;
    readonly source: DocumentGeneration.AllowanceSource;
  }> = [];
  const documents = DocumentGeneration.make({
    allowances: {
      record: (period, source, items) =>
        Effect.sync(() => {
          recorded.push({ allowancePeriodId: period, items, source });
          return { _tag: "Recorded" as const };
        }),
    },
    artifacts: {
      delete: (artifactId) =>
        Effect.sync(() => {
          const index = stored.findIndex(
            (candidate) => candidate.artifact.artifactId === artifactId,
          );
          if (index >= 0) stored.splice(index, 1);
        }),
      get: (artifactId) =>
        Effect.succeed(
          stored.find((candidate) => candidate.artifact.artifactId === artifactId) ?? null,
        ),
      put: (artifact) =>
        Effect.sync(() => {
          stored.push(artifact);
        }),
    },
    authorization: makeAuthorization(retainedCatalog),
    compute: {
      dispose: () => Effect.void,
      generate: () =>
        Effect.sync(() => {
          computeCalls += 1;
          return options.computeResult;
        }),
    },
  });
  return { computeCalls: () => computeCalls, documents, recorded, stored };
};

const completed = (bytes: Uint8Array): DocumentGeneration.ComputeResult => ({
  _tag: "Completed",
  bytes,
  cost: { _tag: "ProvenNoUse" },
  renderedPageCount: 1,
});

// oxlint-disable-next-line effecttsgo/async-function -- pdf-lib exposes a Promise boundary.
const makePdf = async (pages: number) => {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) document.addPage();
  return document.save({ useObjectStreams: false });
};

const date = Schema.decodeSync(Schema.DateFromString);

const makeDocx = (pages: number, explicitBreaks = pages - 1) =>
  zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "docProps/app.xml": strToU8(
      `<?xml version="1.0"?><Properties><Pages>${pages}</Pages></Properties>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/>${'<w:p><w:r><w:br w:type="page"/></w:r></w:p>'.repeat(explicitBreaks)}</w:body></w:document>`,
    ),
  });
