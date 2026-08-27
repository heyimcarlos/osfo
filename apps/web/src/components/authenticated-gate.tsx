import { Navigate, Outlet } from "@tanstack/react-router";

import { useAccountDeletionReplayState } from "../account-deletion-replay-state";
import { authenticatedLandingPath, useAuthState } from "../auth-state";
import { AuthScreen } from "./auth-screen";
import { LoadingScreen } from "./loading-screen";

/** Gate authenticated routes while Better Auth remains identity authority. */
export function AuthenticatedGate() {
  const session = useAuthState();
  const { replay } = useAccountDeletionReplayState();
  if (session.isPending) return <LoadingScreen />;
  if (session.data === null) {
    if (replay.status === "available" || replay.status === "invalid") {
      return <Navigate replace to="/account-deletion/recovery" />;
    }
    return <AuthScreen onAuthenticated={() => undefined} />;
  }
  const landingPath = authenticatedLandingPath(session.data.user);
  if (landingPath === "/get-started") return <Navigate replace to={landingPath} />;
  return <Outlet />;
}
