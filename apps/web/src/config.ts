const productionApiOrigin = "https://api.osfo.ai";

/** Browser API origin, pinned in production so local environment files cannot leak into builds. */
export const apiBaseURL = new URL(
  import.meta.env.PROD ? productionApiOrigin : import.meta.env.VITE_API_URL,
).href.replace(/\/$/, "");
