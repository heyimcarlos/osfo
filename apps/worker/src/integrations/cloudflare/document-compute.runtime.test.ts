/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, vitest/no-standalone-expect -- Promise fakes model external adapters; fixed lease time and assertions stay inside the Effect test. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import { ContentId } from "../../domain/client-content";
import {
  DocumentIntentDigest,
  DocumentSource,
  type CostEvidence,
} from "../../services/document-generation";
import { makeWithSandbox, type AttemptEvidenceStore, type SandboxClient } from "./document-compute";

it.effect("rechecks protected-effect authority before every attempt-evidence R2 mutation", () => {
  const events: Array<string> = [];
  let authorizationChecks = 0;
  const allowancePeriodId = AllowancePeriodId.make("allowance-1");
  const contentId = ContentId.make("document:toolCall:tool-1");
  const intentDigest = DocumentIntentDigest.make("a".repeat(64));
  const cost: Extract<CostEvidence, { _tag: "Incurred" }> = {
    _tag: "Incurred",
    allowancePeriodId,
    basis: "conservative",
    providerOperationId: "provider-operation-1",
    usdMicros: 50_000n,
  };
  const evidence = {
    cost,
    executionLeaseExpiresAt: Date.now() + 10 * 60_000,
    intentDigest,
    renderedPageCount: null,
    status: "claimed" as const,
    userId: UserId.make("user-1"),
  };
  const attempts: AttemptEvidenceStore = {
    claim: async () => {
      events.push("claim");
      return { _tag: "Claimed", created: true, evidence, revision: "revision-1" };
    },
    complete: async () => {
      events.push("complete");
    },
    inspect: async () => null,
    start: async () => {
      events.push("start");
      return true;
    },
  };
  const sandbox: SandboxClient = {
    destroy: async () => undefined,
    exec: async () => ({ exitCode: 0, stdout: '{"renderedPageCount":1}', success: true }),
    exists: async () => ({ exists: false }),
    readStream: async () => ({ content: new ReadableStream<Uint8Array>(), size: 0 }),
    readText: async () => "",
    writeFile: async () => undefined,
  };
  const compute = makeWithSandbox(() => sandbox, attempts, 50_000n);

  return compute
    .generate({
      allowancePeriodId,
      authorizeWrite: Effect.suspend(() => {
        authorizationChecks += 1;
        events.push(`authorize:${authorizationChecks}`);
        return authorizationChecks < 3
          ? Effect.void
          : Effect.fail({
              _tag: "Denied" as const,
              reason: "authorityRevoked" as const,
              resetAt: null,
            });
      }),
      contentId,
      format: "pdf",
      intentDigest,
      source: DocumentSource.make({ pages: [{ lines: ["hello"], title: "Title" }] }),
      supportingVisuals: [],
      userId: UserId.make("user-1"),
    })
    .pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toMatchObject({
            _tag: "AuthorizationFailure",
            failure: { _tag: "Denied", reason: "authorityRevoked" },
          });
          expect(events).toEqual(["authorize:1", "claim", "authorize:2", "start", "authorize:3"]);
          expect(events).not.toContain("complete");
        }),
      ),
    );
});
