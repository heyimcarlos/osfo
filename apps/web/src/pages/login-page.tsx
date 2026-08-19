import { Navigate, useRouter } from "@tanstack/react-router";

import { authenticatedLandingPath, useAuthState } from "../auth-state";
import { AuthScreen } from "../components/auth-screen";
import { LoadingScreen } from "../components/loading-screen";

/** Route-owned sign-in page. */
export function LoginPage() {
  const session = useAuthState();
  const router = useRouter();
  if (session.isPending) return <LoadingScreen />;
  if (session.data !== null)
    return <Navigate replace to={authenticatedLandingPath(session.data.user)} />;
  return <AuthScreen onAuthenticated={() => void router.navigate({ to: "/get-started" })} />;
}
