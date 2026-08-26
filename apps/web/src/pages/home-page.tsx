import { Navigate } from "@tanstack/react-router";

import { authenticatedLandingPath, useAuthState } from "../auth-state";
import { HomeScreen } from "../components/home-screen";
import { LoadingScreen } from "../components/loading-screen";
import { loadBrowserAccountDeletionReplay } from "../lib/account-deletion-replay";

/** Route-owned public home or authenticated registration-aware redirect. */
export function HomePage() {
  const session = useAuthState();
  if (session.isPending) return <LoadingScreen />;
  const replay = loadBrowserAccountDeletionReplay();
  if (session.data === null && (replay.status === "available" || replay.status === "invalid")) {
    return <Navigate replace to="/account-deletion/recovery" />;
  }
  return session.data === null ? (
    <HomeScreen />
  ) : (
    <Navigate replace to={authenticatedLandingPath(session.data.user)} />
  );
}
