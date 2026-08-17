import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";

/** Stage-scoped R2 bucket for immutable generated document artifacts. */
export const Artifacts = Cloudflare.R2.Bucket("GeneratedArtifacts").pipe(RemovalPolicy.retain());
