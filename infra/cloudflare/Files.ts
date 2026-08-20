import { R2 } from "alchemy/Cloudflare";

/** Private immutable source-content bucket for User-owned files. */
export const Files = R2.Bucket("Files");
