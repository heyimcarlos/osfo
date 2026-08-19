import { Navigate } from "@tanstack/react-router";

import { authenticatedLandingPath, useAuthState } from "../auth-state";
import { HomeScreen } from "../components/home-screen";
import { LoadingScreen } from "../components/loading-screen";

/** Route-owned public home or authenticated registration-aware redirect. */
export function HomePage() {
  const session = useAuthState();
  if (session.isPending) return <LoadingScreen />;
  return session.data === null ? (
    <HomeScreen />
  ) : (
    <Navigate replace to={authenticatedLandingPath(session.data.user)} />
  );
}
