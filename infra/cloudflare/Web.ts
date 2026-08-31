import type { Input } from "alchemy";
import { Website } from "alchemy/Cloudflare";
import type { ViteProps } from "alchemy/Cloudflare/Website";
import { Stack } from "alchemy/Stack";

export const productionWebOrigin = "https://osfo.ai";

/** Build settings for one stage without allowing previews to claim production traffic. */
export const webOptionsForStage = (stage: string, apiUrl: Input<string>) => {
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

  if (stage !== "production") {
    return webOptions;
  }

  return {
    ...webOptions,
    domain: null,
    routes: [{ pattern: "osfo.ai/*", zoneName: "osfo.ai" }],
  } satisfies ViteProps;
};

/** Stage-separated Osfo browser application built and served by Cloudflare. */
export default (apiUrl: Input<string>) =>
  Website.Vite(
    "Web",
    Stack.useSync(({ stage }) => webOptionsForStage(stage, apiUrl)),
  );
