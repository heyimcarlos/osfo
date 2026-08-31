import type { Input } from "alchemy";
import { Website } from "alchemy/Cloudflare";
import type { ViteProps } from "alchemy/Cloudflare/Website";
import { Stack } from "alchemy/Stack";

/** Stage-separated Osfo browser application built and served by Cloudflare. */
export default (apiUrl: Input<string>) =>
  Website.Vite(
    "Web",
    Stack.useSync(({ stage }) => {
      const webOptions = {
        assets: {
          notFoundHandling: "single-page-application",
        },
        env: {
          VITE_API_URL: apiUrl,
          VITE_OSFO_STAGE: stage,
        },
        memo: {
          include: ["**/*", "../../packages/api/src/**", "../../packages/ui/src/**"],
          lockfile: true,
        },
        rootDir: "./apps/web",
      } satisfies ViteProps;

      return stage === "production" ? { ...webOptions, domain: "osfo.ai" } : webOptions;
    }),
  );
