import { createContext, useContext, type ReactNode } from "react";

/** Auth facts needed by browser presentation and route gates. */
export type AuthState = {
  readonly data: null | {
    readonly user: {
      readonly id: string;
      readonly name: string;
      readonly phoneNumber?: string | null | undefined;
      readonly registrationCompletedAt?: Date | null | undefined;
    };
  };
  readonly isPending: boolean;
  readonly refreshFromAuthority: () => Promise<void>;
};

/** Select the first route that an authenticated User can safely enter. */
export const authenticatedLandingPath = (
  user: NonNullable<AuthState["data"]>["user"],
): "/get-started" | "/settings" =>
  user.registrationCompletedAt == null ? "/get-started" : "/settings";

const AuthStateContext = createContext<AuthState | null>(null);

/** Provide Better Auth state without giving the router identity authority. */
export function AuthStateProvider({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: AuthState;
}) {
  return <AuthStateContext value={value}>{children}</AuthStateContext>;
}

/** Read the current Better Auth projection from a route-owned page. */
export function useAuthState(): AuthState {
  const value = useContext(AuthStateContext);
  if (value === null) throw new Error("AuthStateProvider is missing");
  return value;
}
