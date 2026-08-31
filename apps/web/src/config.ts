const productionApiOrigin = "https://api.osfo.ai";

interface ApiOriginEnvironment {
  readonly apiUrl: string | undefined;
  readonly productionBuild: boolean;
  readonly stage: string | undefined;
}

/** Resolve a stage-owned API origin while keeping ordinary production builds pinned. */
export const resolveApiBaseURL = ({
  apiUrl,
  productionBuild,
  stage,
}: ApiOriginEnvironment): string => {
  const origin =
    stage === "production" || (productionBuild && stage === undefined)
      ? productionApiOrigin
      : apiUrl;

  if (origin === undefined) {
    throw new Error("VITE_API_URL is required outside the production stage");
  }

  return new URL(origin).href.replace(/\/$/, "");
};

export const apiBaseURL = resolveApiBaseURL({
  apiUrl: import.meta.env.VITE_API_URL,
  productionBuild: import.meta.env.PROD,
  stage: import.meta.env.VITE_OSFO_STAGE,
});
