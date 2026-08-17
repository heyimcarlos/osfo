import { describe, expect, it } from "@effect/vitest";
import { PDFDocument } from "pdf-lib";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { strToU8, zipSync } from "fflate";

import { AllowancePeriodId, PlanPolicyVersion, UserId } from "../src/domain";
import { ActionId } from "../src/domain/action-execution";
import { AuthSessionId } from "../src/domain/auth-session";
import { retainedCatalog } from "../src/domain/plan-policy";
import * as ArtifactValidation from "../src/integrations/cloudflare/document-artifact-validation";
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
            allowancePeriodId,
            basis: "observed",
            providerOperationId: "provider-pdf-1",
            usdMicros: 12_345n,
          },
          renderedPageCount: 1,
        },
      });

      const artifact = yield* fixture.documents.generate(generationRequest("pdf"));

      expect(artifact).toMatchObject({
        artifactRole: {
          _tag: "GeneratedDocumentV1",
          format: "pdf",
          pageCount: 1,
        },
        content: {
          byteLength: pdf.byteLength,
          contentId: "document:toolCall:tool-call-176",
          mediaType: "application/pdf",
        },
      });
      expect(artifact.content.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(fixture.stored).toHaveLength(1);
      expect(fixture.recorded).toEqual([
        {
          allowancePeriodId: AllowancePeriodId.make("allowance-period-176"),
          items: [
            {
              allowanceKind: "vendorUsdMicros",
              basis: "observed",
              quantity: 12_345n,
            },
          ],
          source: {
            sourceId: "provider-pdf-1",
            sourceType: "documentProviderOperation",
          },
        },
        {
          allowancePeriodId: AllowancePeriodId.make("allowance-period-176"),
          items: [
            {
              allowanceKind: "generatedDocuments",
              basis: "observed",
              quantity: 1n,
            },
          ],
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
        artifactRole: { format: "docx", pageCount: 2 },
        content: {
          byteLength: docx.byteLength,
          contentId: "document:toolCall:tool-call-176",
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
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

      expect(pageError).toMatchObject({
        _tag: "InvalidGeneratedArtifact",
        reason: "pageLimit",
      });
      expect(byteError).toMatchObject({
        _tag: "InvalidGeneratedArtifact",
        reason: "byteLimit",
      });
      expect(pageFixture.stored).toHaveLength(0);
      expect(byteFixture.stored).toHaveLength(0);
    }),
  );

  it.effect("rejects invalid output and records no completed document", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        computeResult: completed(strToU8("not a pdf")),
      });

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
            allowancePeriodId,
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
          items: [
            {
              allowanceKind: "vendorUsdMicros",
              basis: "conservative",
              quantity: 50_000n,
            },
          ],
          source: {
            sourceId: "provider-interrupted-1",
            sourceType: "documentProviderOperation",
          },
        },
      ]);
      expect(fixture.cleanupCalls()).toBe(1);
      expect(fixture.stored).toHaveLength(0);
    }),
  );

  it.effect("does not clean up another caller's live Sandbox execution", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let generateCalls = 0;
      let cleanupCalls = 0;
      const compute: DocumentGeneration.DisposableCompute = {
        dispose: () =>
          Effect.sync(() => {
            cleanupCalls += 1;
          }),
        generate: () =>
          Effect.suspend(() => {
            generateCalls += 1;
            if (generateCalls > 1) {
              return Effect.succeed({
                _tag: "AttemptPending" as const,
                cost: { _tag: "ProvenNoUse" as const },
                evidence: "Another caller owns the live Sandbox execution lease",
              });
            }
            return Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return completed(pdf);
            });
          }),
        inspect: () => Effect.succeed(null),
      };
      const fixture = makeFixture({ compute, computeResult: completed(pdf) });
      const winner = yield* Effect.forkChild(fixture.documents.generate(generationRequest("pdf")));
      yield* Deferred.await(entered);

      const pending = yield* fixture.documents.generate(generationRequest("pdf")).pipe(Effect.flip);

      expect(pending).toMatchObject({ _tag: "DocumentComputeInterrupted" });
      expect(cleanupCalls).toBe(0);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(winner);
      expect(cleanupCalls).toBe(1);
      expect(generateCalls).toBe(2);
    }),
  );

  it.effect("rechecks current authorization immediately before disposable compute", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const base = makeAuthorization(retainedCatalog);
      let currentLoads = 0;
      let rechecked = false;
      const fixture = makeFixture({
        authorization: {
          admit: base.admit,
          recheck: (context, operation) => {
            rechecked = true;
            return base.recheck(context, operation);
          },
        },
        beforeCompute: () => {
          expect(currentLoads).toBe(1);
          expect(rechecked).toBe(true);
        },
        computeResult: completed(pdf),
        currentAuthorization: (admitted) =>
          Effect.sync(() => {
            currentLoads += 1;
            return admitted;
          }),
      });

      yield* fixture.documents.generate(generationRequest("pdf"));
    }),
  );

  it.effect("denies when the current entitlement is lost after admission", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const fixture = makeFixture({
        computeResult: completed(pdf),
        currentAuthorization: (admitted) =>
          Effect.succeed({
            ...admitted,
            subscription: { ...admitted.subscription, plan: "free" },
          }),
      });

      const error = yield* fixture.documents.generate(generationRequest("pdf")).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "Denied",
        reason: "missingEntitlement",
      });
      expect(fixture.computeCalls()).toBe(0);
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

  it.effect("recovers pending retention before denying a downgraded generation retry", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      let downgraded = false;
      const fixture = makeFixture({
        computeResult: completed(pdf),
        currentAuthorization: (admitted) =>
          Effect.succeed(
            downgraded
              ? { ...admitted, subscription: { ...admitted.subscription, plan: "free" } }
              : admitted,
          ),
      });
      const artifact = yield* fixture.documents.generate(generationRequest("pdf"));
      const retained = fixture.stored[0];
      if (retained === undefined) return;
      fixture.stored.splice(0, 1, { ...retained, retention: "pending" });
      downgraded = true;

      const denied = yield* fixture.documents.generate(generationRequest("pdf")).pipe(Effect.flip);
      const exported = yield* fixture.documents.export({
        actionId: ActionId.make("free-export-after-recovery-176"),
        authorization: artifactAuthorization("free-export-after-recovery-176", "file.read"),
        contentId: artifact.content.contentId,
      });

      expect(denied).toMatchObject({ _tag: "Denied", reason: "missingEntitlement" });
      expect(fixture.accountCalls()).toBe(2);
      expect(exported.bytes).toEqual(pdf);
      expect(fixture.recorded).toHaveLength(2);
    }),
  );

  it.effect("does not report generation success when Sandbox cleanup is unconfirmed", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const fixture = makeFixture({
        cleanupFails: true,
        computeResult: completed(pdf),
      });

      const error = yield* fixture.documents.generate(generationRequest("pdf")).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "DocumentCleanupUnavailable" });
    }),
  );

  it.effect("cleans up when retained artifact storage fails", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const fixture = makeFixture({
        computeResult: completed(pdf),
        putFails: true,
      });

      const error = yield* fixture.documents.generate(generationRequest("pdf")).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ArtifactStoreUnavailable",
        operation: "put",
      });
      expect(fixture.cleanupCalls()).toBe(1);
    }),
  );

  it.effect("cleans up when compute exits before returning a result", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        computeDefects: true,
        computeResult: {
          _tag: "AttemptUnavailable",
          cost: { _tag: "ProvenNoUse" },
          evidence: "",
        },
      });

      yield* fixture.documents.generate(generationRequest("pdf")).pipe(Effect.exit);

      expect(fixture.cleanupCalls()).toBe(1);
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
              allowancePeriodId,
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

  it.effect("records retry cost against the original admitted allowance period", () =>
    Effect.gen(function* () {
      const originalPeriodId = AllowancePeriodId.make("allowance-period-original-176");
      const fixture = makeFixture({
        computeResult: {
          _tag: "Interrupted",
          cost: {
            _tag: "Incurred",
            allowancePeriodId: originalPeriodId,
            basis: "conservative",
            providerOperationId: "provider-original-period",
            usdMicros: 50_000n,
          },
          evidence: "The original attempt needs reconciliation",
        },
      });

      yield* fixture.documents.generate(generationRequest("pdf")).pipe(Effect.flip);

      expect(fixture.recorded[0]?.allowancePeriodId).toBe(originalPeriodId);
    }),
  );

  it.effect("finishes an admitted attempt after the generation allowance becomes capped", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const originalPeriodId = AllowancePeriodId.make("allowance-period-recovery-176");
      const recovery = {
        cost: {
          _tag: "Incurred" as const,
          allowancePeriodId: originalPeriodId,
          basis: "conservative" as const,
          providerOperationId: "provider-recovery",
          usdMicros: 50_000n,
        },
        intentDigest: DocumentGeneration.DocumentIntentDigest.make("6".repeat(64)),
      };
      const fixture = makeFixture({
        computeResult: { ...completed(pdf), cost: recovery.cost },
        recovery,
      });
      const request = generationRequest("pdf");

      const artifact = yield* fixture.documents.generate({
        ...request,
        authorization: {
          ...request.authorization,
          allowance: {
            _tag: "Metered",
            allowancePeriodId,
            endsAt: date("2026-09-01T00:00:00.000Z"),
            plan: "adventurer",
            planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
            startsAt: date("2026-08-01T00:00:00.000Z"),
            usage: [
              {
                allowanceKind: "generatedDocuments",
                quantity: 10n,
              },
            ],
          },
        },
      });

      expect(artifact.artifactRole).toMatchObject({
        _tag: "GeneratedDocumentV1",
      });
      expect(fixture.recorded[0]?.allowancePeriodId).toBe(originalPeriodId);
    }),
  );

  it.effect("deletes the retained artifact", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const fixture = makeFixture({ computeResult: completed(pdf) });
      const artifact = yield* fixture.documents.generate(generationRequest("pdf"));

      yield* fixture.documents.delete({
        actionId: ActionId.make("delete-176"),
        contentId: artifact.content.contentId,
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

      const denied = yield* fixture.documents
        .export({
          actionId: ActionId.make("foreign-export-176"),
          contentId: artifact.content.contentId,
          authorization: foreignAuthorization("foreign-export-176"),
        })
        .pipe(Effect.flip);
      expect(fixture.readCalls()).toBe(0);

      const exported = yield* fixture.documents.export({
        actionId: ActionId.make("export-176"),
        contentId: artifact.content.contentId,
        authorization: artifactAuthorization("export-176", "file.read"),
      });

      expect(exported).toEqual({ artifact, bytes: pdf });
      expect(denied).toMatchObject({
        _tag: "Denied",
        reason: "ownershipRequired",
      });
      expect(fixture.readCalls()).toBe(1);
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

  it.effect("rejects a DOCX package without OOXML relationships", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        computeResult: completed(makeDocx(1, 0, false)),
      });

      const error = yield* fixture.documents.generate(generationRequest("docx")).pipe(Effect.flip);

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
            subscription: {
              ...request.authorization.subscription,
              plan: "free",
            },
          },
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "Denied",
        reason: "missingEntitlement",
      });
      expect(fixture.computeCalls()).toBe(0);
    }),
  );

  it.effect("exports retained document content after downgrade to Free", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => makePdf(1));
      const fixture = makeFixture({ computeResult: completed(pdf) });
      const artifact = yield* fixture.documents.generate(generationRequest("pdf"));
      const authorization = artifactAuthorization("free-export-176", "file.read");

      const exported = yield* fixture.documents.export({
        actionId: ActionId.make("free-export-176"),
        contentId: artifact.content.contentId,
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
      });

      expect(exported).toEqual({ artifact, bytes: pdf });
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

const artifactAuthorization = (actionId: string, operation: "file.delete" | "file.read") => {
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
  const authorization = artifactAuthorization(actionId, "file.read");
  if (authorization.authority._tag !== "AuthSession") return authorization;
  return {
    ...authorization,
    authority: { ...authorization.authority, userId: foreignUserId },
    user: { _tag: "ActiveUser" as const, userId: foreignUserId },
  };
};

const makeFixture = (options: {
  readonly authorization?: ReturnType<typeof makeAuthorization>;
  readonly beforeCompute?: () => void;
  readonly cleanupFails?: boolean;
  readonly compute?: DocumentGeneration.DisposableCompute;
  readonly computeResult: DocumentGeneration.ComputeResult;
  readonly computeDefects?: boolean;
  readonly currentAuthorization?: DocumentGeneration.MakeOptions["currentAuthorization"];
  readonly putFails?: boolean;
  readonly recovery?: DocumentGeneration.ComputeRecovery;
}) => {
  let computeCalls = 0;
  let cleanupCalls = 0;
  let accountCalls = 0;
  let readCalls = 0;
  const stored: Array<DocumentGeneration.StoredArtifact> = [];
  const recorded: Array<{
    readonly allowancePeriodId: AllowancePeriodId;
    readonly items: ReadonlyArray<DocumentGeneration.AllowanceItem>;
    readonly source: DocumentGeneration.AllowanceSource;
  }> = [];
  const documents = DocumentGeneration.make({
    artifactValidator: ArtifactValidation,
    allowances: {
      record: (period, source, items) =>
        Effect.sync(() => {
          recorded.push({ allowancePeriodId: period, items, source });
          return { _tag: "Recorded" as const };
        }),
    },
    artifacts: {
      account: (contentId) =>
        Effect.sync(() => {
          accountCalls += 1;
          const index = stored.findIndex(
            (candidate) => candidate.artifact.content.contentId === contentId,
          );
          const retained = stored[index];
          if (retained !== undefined) {
            stored.splice(index, 1, { ...retained, retention: "accounted" });
          }
        }),
      delete: (contentId) =>
        Effect.sync(() => {
          const index = stored.findIndex(
            (candidate) => candidate.artifact.content.contentId === contentId,
          );
          if (index >= 0) stored.splice(index, 1);
        }),
      inspect: (contentId) =>
        Effect.succeed(
          stored.find((candidate) => candidate.artifact.content.contentId === contentId) ?? null,
        ),
      put: (artifact) =>
        options.putFails === true
          ? Effect.fail(
              new DocumentGeneration.ArtifactStoreUnavailable({
                cause: new Error("put failed"),
                message: "R2 put failed",
                operation: "put",
              }),
            )
          : Effect.sync(() => {
              stored.push(artifact);
            }),
      readBytes: (metadata) =>
        Effect.sync(() => {
          readCalls += 1;
          return (
            stored.find(
              (candidate) =>
                candidate.artifact.content.contentId === metadata.artifact.content.contentId,
            )?.bytes ?? new Uint8Array()
          );
        }),
    },
    authorization: options.authorization ?? makeAuthorization(retainedCatalog),
    currentAuthorization: options.currentAuthorization ?? ((admitted) => Effect.succeed(admitted)),
    compute: options.compute ?? {
      dispose: (contentId) =>
        Effect.sync(() => {
          cleanupCalls += 1;
        }).pipe(
          Effect.andThen(
            options.cleanupFails === true
              ? Effect.fail(
                  new DocumentGeneration.DocumentCleanupUnavailable({
                    cause: new Error("cleanup failed"),
                    contentId,
                    message: "Cleanup could not be confirmed",
                  }),
                )
              : Effect.void,
          ),
        ),
      generate: () =>
        options.computeDefects === true
          ? Effect.die("compute defect")
          : Effect.sync(() => {
              options.beforeCompute?.();
              computeCalls += 1;
              return options.computeResult;
            }),
      inspect: () => Effect.succeed(options.recovery ?? null),
    },
  });
  return {
    accountCalls: () => accountCalls,
    cleanupCalls: () => cleanupCalls,
    computeCalls: () => computeCalls,
    documents,
    readCalls: () => readCalls,
    recorded,
    stored,
  };
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

const makeDocx = (pages: number, explicitBreaks = pages - 1, relationships = true) =>
  zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "docProps/app.xml": strToU8(
      `<?xml version="1.0"?><Properties><Pages>${pages}</Pages></Properties>`,
    ),
    "_rels/.rels": strToU8(
      relationships
        ? '<?xml version="1.0"?><Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
        : "",
    ),
    "word/_rels/document.xml.rels": strToU8(
      relationships ? '<?xml version="1.0"?><Relationships></Relationships>' : "",
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/>${'<w:p><w:r><w:br w:type="page"/></w:r></w:p>'.repeat(explicitBreaks)}</w:body></w:document>`,
    ),
  });
