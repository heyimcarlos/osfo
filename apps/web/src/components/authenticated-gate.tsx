import { Navigate, Outlet } from "@tanstack/react-router";

import { authenticatedLandingPath, useAuthState } from "../auth-state";
import { loadBrowserAccountDeletionReplay } from "../lib/account-deletion-replay";
import { AuthScreen } from "./auth-screen";
import { LoadingScreen } from "./loading-screen";

/** Gate authenticated routes while Better Auth remains identity authority. */
export function AuthenticatedGate() {
  const session = useAuthState();
  if (session.isPending) return <LoadingScreen />;
  if (session.data === null) {
    const replay = loadBrowserAccountDeletionReplay();
    if (replay.status === "available" || replay.status === "invalid") {
      return <Navigate replace to="/account-deletion/recovery" />;
    }
    return <AuthScreen onAuthenticated={() => undefined} />;
  }
  const landingPath = authenticatedLandingPath(session.data.user);
  if (landingPath === "/get-started") return <Navigate replace to={landingPath} />;
  return <Outlet />;
}
