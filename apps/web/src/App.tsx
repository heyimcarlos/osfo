import { RouterProvider } from "@tanstack/react-router";

import { AuthStateProvider } from "./auth-state";
import { authClient } from "./lib/auth-client";
import { appRouter } from "./router";

/** Osfo browser composition root. */
export function App() {
  const session = authClient.useSession();
  const authState = {
    data: session.data,
    isPending: session.isPending,
    refreshFromAuthority: () => session.refetch({ query: { disableCookieCache: true } }),
  };
  return (
    <AuthStateProvider value={authState}>
      <RouterProvider router={appRouter} />
    </AuthStateProvider>
  );
}
