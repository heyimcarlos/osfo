import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { Effect, Schema } from "effect";

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
    Effect.tryPromise(() => render(binding, conservativeVendorUsdMicros, input)).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          interrupted(
            input.artifactId,
            conservativeVendorUsdMicros,
            "The disposable sandbox stopped before verified output was available",
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
): Promise<ComputeResult> => {
  const sandbox = sandboxFor(binding, input.artifactId);
  const outputPath = `/workspace/document.${input.format}`;
  const cached = await sandbox.exists(outputPath);
  if (!cached.exists) {
    await sandbox.writeFile(
      "/workspace/source.json",
      Schema.encodeSync(Schema.fromJsonString(DocumentSource))(input.source),
    );
    const result = await sandbox.exec(
      `python3 /opt/osfo/render_document.py --format ${input.format} --input /workspace/source.json --output ${outputPath}`,
      { timeout: 60_000 },
    );
    if (!result.success) {
      return interrupted(
        input.artifactId,
        conservativeVendorUsdMicros,
        `The document renderer exited with code ${result.exitCode}`,
      );
    }
  }
  const file = await sandbox.readFile(outputPath, { encoding: "base64" });
  return {
    _tag: "Completed",
    bytes: decodeBase64(file.content),
    cost: incurred(input.artifactId, conservativeVendorUsdMicros),
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

const incurred = (artifactId: ArtifactId, conservativeVendorUsdMicros: bigint) => ({
  _tag: "Incurred" as const,
  basis: "conservative" as const,
  providerOperationId: `cloudflare-sandbox:${artifactId}`,
  usdMicros: conservativeVendorUsdMicros,
});

const interrupted = (
  artifactId: ArtifactId,
  conservativeVendorUsdMicros: bigint,
  evidence: string,
): ComputeResult => ({
  _tag: "Interrupted",
  cost: incurred(artifactId, conservativeVendorUsdMicros),
  evidence,
});

const decodeBase64 = (encoded: string) =>
  Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
