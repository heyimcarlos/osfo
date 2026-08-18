import { Outlet } from "@tanstack/react-router";

import { useAuthState } from "../auth-state";
import { AuthScreen } from "./auth-screen";
import { LoadingScreen } from "./loading-screen";

/** Gate authenticated routes while Better Auth remains identity authority. */
export function AuthenticatedGate() {
  const session = useAuthState();
  if (session.isPending) return <LoadingScreen />;
  if (session.data === null)
    return <AuthScreen onAuthenticated={() => undefined} enableCredentials={import.meta.env.DEV} />;
  return <Outlet />;
}
