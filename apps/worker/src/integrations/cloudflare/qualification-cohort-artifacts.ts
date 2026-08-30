/* oxlint-disable effecttsgo/async-function -- Cloudflare Durable Object RPC and Web Crypto are Promise-native host boundaries. */
import { Effect, Schema } from "effect";

import { qualificationChecksum } from "../../qualification/qualification-checksum";
import {
  qualificationCohortArtifactProtocol,
  type QualificationCohortArtifactFamily,
  type QualificationCohortArtifactFenceOutcome,
  type QualificationCohortArtifactFenceInput,
  type QualificationCohortArtifactRetainInput,
  type QualificationCohortArtifactRetainOutcome,
} from "../../qualification/cohort-artifact-authority-contract";

export class QualificationCohortArtifactAuthorityUnavailable extends Schema.TaggedError<QualificationCohortArtifactAuthorityUnavailable>()(
  "QualificationCohortArtifactAuthorityUnavailable",
  { cause: Schema.Defect(), operation: Schema.String },
) {}

export interface RetainInput {
  readonly body: string;
  readonly executionId: string;
  readonly family: QualificationCohortArtifactFamily;
  readonly key: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/** Narrow private RPC port used by the qualification cohort artifact adapter. */
export interface QualificationCohortArtifactAuthorityNamespace {
  readonly getByName: (executionId: string) => {
    readonly fence: (
      input: QualificationCohortArtifactFenceInput,
    ) => Promise<QualificationCohortArtifactFenceOutcome>;
    readonly retain: (
      input: QualificationCohortArtifactRetainInput,
    ) => Promise<QualificationCohortArtifactRetainOutcome>;
  };
}

const sha256Hex = async (body: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const retainQualificationCohortArtifact = Effect.fn("QualificationCohortArtifacts.retain")(
  (
    namespace: QualificationCohortArtifactAuthorityNamespace,
    input: RetainInput,
  ): Effect.Effect<
    QualificationCohortArtifactRetainOutcome,
    QualificationCohortArtifactAuthorityUnavailable
  > =>
    Effect.tryPromise({
      catch: (cause) =>
        new QualificationCohortArtifactAuthorityUnavailable({
          cause,
          operation: "retain",
        }),
      try: async (): Promise<QualificationCohortArtifactRetainOutcome> => {
        const metadata = {
          ...input.metadata,
          "osfo-body-sha256": await sha256Hex(input.body),
        };
        return await namespace.getByName(input.executionId).retain({
          ...input,
          metadata,
          operationToken: qualificationChecksum({
            body: input.body,
            executionId: input.executionId,
            family: input.family,
            key: input.key,
            metadata,
          }),
          protocolVersion: qualificationCohortArtifactProtocol,
        });
      },
    }),
);

export const fenceQualificationCohortArtifacts = Effect.fn("QualificationCohortArtifacts.fence")(
  (
    namespace: QualificationCohortArtifactAuthorityNamespace,
    executionId: string,
  ): Effect.Effect<
    QualificationCohortArtifactFenceOutcome,
    QualificationCohortArtifactAuthorityUnavailable
  > =>
    Effect.tryPromise({
      catch: (cause) =>
        new QualificationCohortArtifactAuthorityUnavailable({
          cause,
          operation: "fence",
        }),
      try: async (): Promise<QualificationCohortArtifactFenceOutcome> =>
        await namespace.getByName(executionId).fence({
          executionId,
          protocolVersion: qualificationCohortArtifactProtocol,
        }),
    }),
);
