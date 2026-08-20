import { R2 } from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";

/** Stage-scoped R2 bucket for immutable generated document artifacts. */
export const Artifacts = R2.Bucket("GeneratedArtifacts").pipe(retain());
