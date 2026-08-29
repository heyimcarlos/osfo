import { DurableObject } from "alchemy/Cloudflare";

/** Shared Directory namespace used by the API and the qualification authority reader. */
export const OsfoDirectory = DurableObject("OsfoDirectory", {
  className: "OsfoDirectory",
});
