import { phoneNumberClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

const defaultApiOrigin = import.meta.env.DEV ? "http://localhost:8787" : "https://api.osfo.ai";
const apiOrigin = import.meta.env.VITE_API_URL ?? defaultApiOrigin;
const authBaseURL = new URL("/auth", apiOrigin).href.replace(/\/$/, "");

/** Browser client for the Osfo Better Auth Worker routes. */
export const authClient = createAuthClient({
  baseURL: authBaseURL,
  plugins: [phoneNumberClient()],
});
