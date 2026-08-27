import { Navigate } from "@tanstack/react-router";

import { useAccountDeletionReplayState } from "../account-deletion-replay-state";
import { authenticatedLandingPath, useAuthState } from "../auth-state";
import { HomeScreen } from "../components/home-screen";
import { LoadingScreen } from "../components/loading-screen";

/** Route-owned public home or authenticated registration-aware redirect. */
export function HomePage() {
  const session = useAuthState();
  const { replay } = useAccountDeletionReplayState();
  if (session.isPending) return <LoadingScreen />;
  if (session.data === null && (replay.status === "available" || replay.status === "invalid")) {
    return <Navigate replace to="/account-deletion/recovery" />;
  }
  return session.data === null ? (
    <HomeScreen />
  ) : (
    <Navigate replace to={authenticatedLandingPath(session.data.user)} />
  );
}
