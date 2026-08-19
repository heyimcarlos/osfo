import { Navigate, useNavigate, useParams, useSearch } from "@tanstack/react-router";

import { useAuthState } from "../auth-state";
import { GetStartedScreen } from "../components/get-started-screen";
import { LoadingScreen } from "../components/loading-screen";

/** Route-owned registration and invitation page. */
export function GetStartedPage() {
  const { lang } = useSearch({ from: "/get-started" });
  return <RegistrationPage {...(lang === undefined ? {} : { initialLocale: lang })} />;
}

/** Route-owned invitation continuation page. */
export function VerifyPage() {
  const { token } = useParams({ from: "/verify/$token" });
  return <RegistrationPage invitationToken={token} />;
}

function RegistrationPage({
  initialLocale,
  invitationToken,
}: {
  readonly initialLocale?: "en" | "es";
  readonly invitationToken?: string;
}) {
  const navigate = useNavigate();
  const session = useAuthState();
  if (session.isPending) return <LoadingScreen />;
  if (invitationToken === undefined && session.data?.user.registrationCompletedAt != null)
    return <Navigate replace to="/settings" />;
  return (
    <GetStartedScreen
      {...(invitationToken === undefined ? {} : { invitationToken })}
      enrollmentProvider="telegram"
      {...(initialLocale === undefined ? {} : { initialLocale })}
      isAuthenticated={session.data !== null}
      onComplete={() => {
        void session
          .refreshFromAuthority()
          .then(() => navigate({ to: session.data === null ? "/" : "/settings" }));
      }}
    />
  );
}
