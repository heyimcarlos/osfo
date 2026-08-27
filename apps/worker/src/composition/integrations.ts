import { Effect, Option, Predicate } from "effect";

import type { CloudflareConfig } from "../config";
import { ContentId } from "../domain/client-content";
import { ComposioPersistence } from "../integrations/composio/persistence";
import { ComposioProvider } from "../integrations/composio/provider";
import { DocumentArtifacts } from "../integrations/cloudflare/document-artifacts";
import { Integrations } from "../services/integrations";

/** Compose production Integrations only when the ignored Composio secret is available. */
export const make = (
  config: Pick<CloudflareConfig, "composio">,
  storage: DurableObjectStorage,
  artifacts?: R2Bucket,
): Option.Option<Integrations.Interface> =>
  config.composio === null
    ? Option.none()
    : Option.some(
        artifacts === undefined
          ? Integrations.make({
              ...ComposioPersistence.make(storage),
              ...ComposioProvider.make(config.composio.apiKey),
            })
          : Integrations.make({
              ...ComposioPersistence.make(storage),
              ...ComposioProvider.make(config.composio.apiKey),
              ...artifactAccess(artifacts),
            }),
      );

const artifactAccess = (bucket: R2Bucket): Integrations.IntegrationArtifactAccess => {
  const store = DocumentArtifacts.make(bucket);
  return {
    readOwned: (input) =>
      Effect.gen(function* () {
        const contentId = ContentId.make(input.artifactId);
        const metadata = yield* store.inspect(contentId);
        if (
          metadata === null ||
          metadata.userId !== input.userId ||
          metadata.retention !== "accounted"
        ) {
          return yield* artifactUnavailable("inaccessible");
        }
        const content = metadata.artifact.content;
        if (content.contentId !== contentId) return yield* artifactUnavailable("identityMismatch");
        if (content.byteLength !== input.expectedBytes)
          return yield* artifactUnavailable("sizeMismatch");
        if (
          content.mediaType !== input.mediaType ||
          !hasExpectedExtension(input.fileName, input.mediaType)
        ) {
          return yield* artifactUnavailable("mediaMismatch");
        }
        return {
          bytes: yield* store.readBytes(metadata),
          fileName: input.fileName,
          mediaType: input.mediaType,
        };
      }).pipe(
        Effect.mapError((failure) =>
          Predicate.isTagged(failure, "IntegrationArtifactUnavailable")
            ? failure
            : new Integrations.IntegrationArtifactUnavailable({
                message: "The owned artifact is unavailable",
                reason: "inaccessible",
              }),
        ),
      ),
  };
};

const hasExpectedExtension = (fileName: string, mediaType: string) =>
  fileName.toLowerCase().endsWith(mediaType === "application/pdf" ? ".pdf" : ".docx");

const artifactUnavailable = (reason: Integrations.IntegrationArtifactUnavailable["reason"]) =>
  new Integrations.IntegrationArtifactUnavailable({
    message: "The owned artifact does not match the approved delivery",
    reason,
  });

export * as IntegrationComposition from "./integrations";
