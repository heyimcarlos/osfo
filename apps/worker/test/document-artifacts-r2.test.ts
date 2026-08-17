import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { PDFDocument } from "pdf-lib";
import { Effect } from "effect";

import { AllowancePeriodId, UserId } from "../src/domain";
import { ContentId } from "../src/domain/client-content";
import * as DocumentArtifact from "../src/domain/document-artifact";
import * as ArtifactR2 from "../src/integrations/cloudflare/document-artifacts";
import { attemptKeyFor } from "../src/integrations/cloudflare/document-storage-keys";
import { DocumentIntentDigest } from "../src/services/document-generation";

describe("generated document R2 artifacts", () => {
  it.effect("retains, verifies, and deletes one immutable artifact", () =>
    Effect.gen(function* () {
      const bytes = yield* Effect.promise(makePdf);
      const contentId = ContentId.make("document:toolCall:r2-artifact-176");
      const artifact = yield* DocumentArtifact.parse(contentId, "pdf", bytes, 1);
      const store = ArtifactR2.make(env.ARTIFACTS);
      const retained = {
        allowancePeriodId: AllowancePeriodId.make("allowance-period-r2-176"),
        artifact,
        bytes,
        cost: { _tag: "ProvenNoUse" as const },
        format: "pdf" as const,
        intentDigest: DocumentIntentDigest.make("2".repeat(64)),
        owner: { _tag: "ToolCall" as const, toolCallId: "r2-artifact-176" },
        userId: UserId.make("user-r2-176"),
      };

      yield* store.put(retained);
      yield* Effect.promise(() => env.ARTIFACTS.put(attemptKeyFor(contentId), new Uint8Array()));
      const read = yield* store.inspect(contentId);

      expect(read).not.toBeNull();
      expect(read?.artifact).toEqual(artifact);
      if (read === null) return;
      expect(yield* store.readBytes(read)).toEqual(bytes);

      yield* store.delete(contentId);
      expect(yield* store.inspect(contentId)).toBeNull();
      expect(yield* Effect.promise(() => env.ARTIFACTS.head(attemptKeyFor(contentId)))).toBeNull();
    }),
  );

  it.effect("fails closed when retained bytes do not match their digest", () =>
    Effect.gen(function* () {
      const bytes = yield* Effect.promise(makePdf);
      const contentId = ContentId.make("document:toolCall:r2-digest-176");
      const artifact = yield* DocumentArtifact.parse(contentId, "pdf", bytes, 1);
      const store = ArtifactR2.make(env.ARTIFACTS);
      yield* store.put({
        allowancePeriodId: AllowancePeriodId.make("allowance-period-r2-digest-176"),
        artifact,
        bytes,
        cost: { _tag: "ProvenNoUse" },
        format: "pdf",
        intentDigest: DocumentIntentDigest.make("3".repeat(64)),
        owner: { _tag: "ToolCall", toolCallId: "r2-digest-176" },
        userId: UserId.make("user-r2-digest-176"),
      });
      const listed = yield* Effect.promise(() =>
        env.ARTIFACTS.list({ include: ["customMetadata"], prefix: "client-content/" }),
      );
      const object = listed.objects.find((candidate) =>
        candidate.customMetadata?.osfo?.includes(contentId),
      );
      expect(object).toBeDefined();
      const customMetadata = object?.customMetadata;
      if (object === undefined || customMetadata === undefined) return;
      yield* Effect.promise(() =>
        env.ARTIFACTS.put(object.key, new Uint8Array(bytes.byteLength), {
          customMetadata,
        }),
      );

      const metadata = yield* store.inspect(contentId);
      if (metadata === null) return;
      const error = yield* store.readBytes(metadata).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "ArtifactIntegrityFailure" });
      yield* store.delete(contentId);
    }),
  );
});

// oxlint-disable-next-line effecttsgo/async-function -- pdf-lib exposes a Promise boundary.
const makePdf = async () => {
  const document = await PDFDocument.create();
  document.addPage();
  return document.save({ useObjectStreams: false });
};
