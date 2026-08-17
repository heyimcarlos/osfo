import * as Cloudflare from "alchemy/Cloudflare";

/** Private immutable source-content bucket for User-owned files. */
export const Files = Cloudflare.R2.Bucket("Files");
