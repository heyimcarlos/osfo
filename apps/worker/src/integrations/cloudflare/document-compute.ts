import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { Effect, Random, Schema } from "effect";

import type { ArtifactId, DocumentFormat } from "../../domain/document-artifact";
import { DocumentSource } from "../../services/document-generation";
import type { ComputeResult, DisposableCompute } from "../../services/document-generation";

/** Construct disposable Python document compute over Cloudflare Sandbox. */
export const make = (
  binding: DurableObjectNamespace<Sandbox>,
  conservativeVendorUsdMicros: bigint,
): DisposableCompute => ({
  dispose: (artifactId) =>
    Effect.tryPromise(() => sandboxFor(binding, artifactId).destroy()).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Disposable document sandbox cleanup failed").pipe(
          Effect.annotateLogs({ artifactId, cause: String(cause) }),
        ),
      ),
    ),
  generate: (input) =>
    Effect.all([Random.next, Random.next]).pipe(
      Effect.map(
        ([high, low]) =>
          `cloudflare-sandbox:${input.artifactId}:${high.toString(16)}${low.toString(16)}`,
      ),
      Effect.flatMap((providerOperationId) =>
        Effect.tryPromise(() =>
          render(binding, conservativeVendorUsdMicros, input, providerOperationId),
        ).pipe(
          Effect.catchCause(() =>
            Effect.succeed(
              interrupted(
                providerOperationId,
                conservativeVendorUsdMicros,
                "The disposable sandbox stopped before verified output was available",
              ),
            ),
          ),
        ),
      ),
    ),
});

// oxlint-disable-next-line effecttsgo/async-function -- Sandbox SDK is a Promise-based boundary.
const render = async (
  binding: DurableObjectNamespace<Sandbox>,
  conservativeVendorUsdMicros: bigint,
  input: {
    readonly artifactId: ArtifactId;
    readonly format: DocumentFormat;
    readonly intentDigest: string;
    readonly source: DocumentSource;
  },
  attemptOperationId: string,
): Promise<ComputeResult> => {
  const sandbox = sandboxFor(binding, input.artifactId);
  const outputPath = `/workspace/document-${input.intentDigest}.${input.format}`;
  const evidencePath = `/workspace/evidence-${input.intentDigest}.txt`;
  const sourcePath = `/workspace/source-${input.intentDigest}.json`;
  const [cachedOutput, cachedEvidence] = await Promise.all([
    sandbox.exists(outputPath),
    sandbox.exists(evidencePath),
  ]);
  let providerOperationId: string;
  if (!cachedOutput.exists || !cachedEvidence.exists) {
    providerOperationId = attemptOperationId;
    await sandbox.writeFile(
      sourcePath,
      Schema.encodeSync(Schema.fromJsonString(DocumentSource))(input.source),
    );
    const result = await sandbox.exec(
      `python3 /opt/osfo/render_document.py --format ${input.format} --input ${sourcePath} --output ${outputPath}`,
      { timeout: 60_000 },
    );
    if (!result.success) {
      return interrupted(
        providerOperationId,
        conservativeVendorUsdMicros,
        `The document renderer exited with code ${result.exitCode}`,
      );
    }
    await sandbox.writeFile(evidencePath, providerOperationId);
  } else {
    providerOperationId = (await sandbox.readFile(evidencePath)).content;
  }
  const file = await sandbox.readFile(outputPath, { encoding: "base64" });
  return {
    _tag: "Completed",
    bytes: decodeBase64(file.content),
    cost: incurred(providerOperationId, conservativeVendorUsdMicros),
  };
};

const sandboxFor = (binding: DurableObjectNamespace<Sandbox>, artifactId: ArtifactId) =>
  getSandbox(binding, artifactId, {
    enableDefaultSession: false,
    keepAlive: false,
    normalizeId: true,
    sleepAfter: "2m",
    transport: "rpc",
  });

const incurred = (providerOperationId: string, conservativeVendorUsdMicros: bigint) => ({
  _tag: "Incurred" as const,
  basis: "conservative" as const,
  providerOperationId,
  usdMicros: conservativeVendorUsdMicros,
});

const interrupted = (
  providerOperationId: string,
  conservativeVendorUsdMicros: bigint,
  evidence: string,
): ComputeResult => ({
  _tag: "Interrupted",
  cost: incurred(providerOperationId, conservativeVendorUsdMicros),
  evidence,
});

const decodeBase64 = (encoded: string) =>
  Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
