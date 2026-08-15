import { phoneNumberClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

const authBaseURL = new URL("/auth", import.meta.env.VITE_API_URL).href.replace(/\/$/, "");

/** Browser client for the Osfo Better Auth Worker routes. */
export const authClient = createAuthClient({
  baseURL: authBaseURL,
  plugins: [phoneNumberClient()],
});
