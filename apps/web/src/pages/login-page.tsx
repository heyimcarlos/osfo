import { Navigate, useRouter } from "@tanstack/react-router";

import { useAuthState } from "../auth-state";
import { AuthScreen } from "../components/auth-screen";
import { LoadingScreen } from "../components/loading-screen";

/** Route-owned sign-in page. */
export function LoginPage() {
  const session = useAuthState();
  const router = useRouter();
  if (session.isPending) return <LoadingScreen />;
  if (session.data !== null) return <Navigate replace to="/think" />;
  return (
    <AuthScreen
      enableCredentials={import.meta.env.DEV}
      onAuthenticated={() => void router.navigate({ to: "/think" })}
    />
  );
}
