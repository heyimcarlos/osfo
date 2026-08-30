/* oxlint-disable effecttsgo/async-function -- Cloudflare Durable Object RPC and Web Crypto are Promise-native host boundaries. */
import { Effect, Schema } from "effect";

import { qualificationChecksum } from "../../qualification/qualification-checksum";
import {
  qualificationCohortArtifactProtocol,
  type QualificationCohortArtifactDeleteOutcome,
  type QualificationCohortArtifactDeletePageInput,
  type QualificationCohortArtifactDeleteRootInput,
  type QualificationCohortArtifactFamily,
  type QualificationCohortArtifactFenceOutcome,
  type QualificationCohortArtifactFenceInput,
  type QualificationCohortArtifactInspectInput,
  type QualificationCohortArtifactInspection,
  type QualificationCohortArtifactRetainInput,
  type QualificationCohortArtifactRetainOutcome,
  type QualificationCohortArtifactSealPageInput,
  type QualificationCohortArtifactSealPageOutcome,
  type QualificationCohortArtifactSealRootInput,
  type QualificationCohortArtifactSealRootOutcome,
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
    readonly deletePage: (
      input: QualificationCohortArtifactDeletePageInput,
    ) => Promise<QualificationCohortArtifactDeleteOutcome>;
    readonly deleteRoot: (
      input: QualificationCohortArtifactDeleteRootInput,
    ) => Promise<QualificationCohortArtifactDeleteOutcome>;
    readonly fence: (
      input: QualificationCohortArtifactFenceInput,
    ) => Promise<QualificationCohortArtifactFenceOutcome>;
    readonly retain: (
      input: QualificationCohortArtifactRetainInput,
    ) => Promise<QualificationCohortArtifactRetainOutcome>;
    readonly inspect: (
      input: QualificationCohortArtifactInspectInput,
    ) => Promise<QualificationCohortArtifactInspection>;
    readonly sealPage: (
      input: QualificationCohortArtifactSealPageInput,
    ) => Promise<QualificationCohortArtifactSealPageOutcome>;
    readonly sealRoot: (
      input: QualificationCohortArtifactSealRootInput,
    ) => Promise<QualificationCohortArtifactSealRootOutcome>;
  };
}

const callAuthority = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) =>
      new QualificationCohortArtifactAuthorityUnavailable({
        cause,
        operation,
      }),
    try: evaluate,
  });

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

export const deleteQualificationCohortArtifactPage = Effect.fn(
  "QualificationCohortArtifacts.deletePage",
)(
  (
    namespace: QualificationCohortArtifactAuthorityNamespace,
    input: QualificationCohortArtifactDeletePageInput,
  ) => callAuthority("deletePage", () => namespace.getByName(input.executionId).deletePage(input)),
);

export const sealQualificationCohortArtifactPage = Effect.fn(
  "QualificationCohortArtifacts.sealPage",
)(
  (
    namespace: QualificationCohortArtifactAuthorityNamespace,
    input: QualificationCohortArtifactSealPageInput,
  ) => callAuthority("sealPage", () => namespace.getByName(input.executionId).sealPage(input)),
);

export const deleteQualificationCohortArtifactRoot = Effect.fn(
  "QualificationCohortArtifacts.deleteRoot",
)(
  (
    namespace: QualificationCohortArtifactAuthorityNamespace,
    input: QualificationCohortArtifactDeleteRootInput,
  ) => callAuthority("deleteRoot", () => namespace.getByName(input.executionId).deleteRoot(input)),
);

export const sealQualificationCohortArtifactRoot = Effect.fn(
  "QualificationCohortArtifacts.sealRoot",
)(
  (
    namespace: QualificationCohortArtifactAuthorityNamespace,
    input: QualificationCohortArtifactSealRootInput,
  ) => callAuthority("sealRoot", () => namespace.getByName(input.executionId).sealRoot(input)),
);

export const inspectQualificationCohortArtifacts = Effect.fn(
  "QualificationCohortArtifacts.inspect",
)((namespace: QualificationCohortArtifactAuthorityNamespace, executionId: string) =>
  callAuthority("inspect", () =>
    namespace.getByName(executionId).inspect({
      executionId,
      protocolVersion: qualificationCohortArtifactProtocol,
    }),
  ),
);
