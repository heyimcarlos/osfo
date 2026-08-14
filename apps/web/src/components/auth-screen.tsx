import { Button } from "@osfo/ui/components/button";
import { useState } from "react";

import { PhoneAuthForm } from "./phone-auth-form";
import { SignInForm } from "./sign-in-form";
import { SignUpForm } from "./sign-up-form";

interface AuthScreenProps {
  readonly onAuthenticated: () => void;
}

/** Osfo sign-in surface for phone verification and temporary credentials. */
export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [credentialMode, setCredentialMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [method, setMethod] = useState<"credentials" | "phone">("credentials");

  return (
    <main className="flex min-h-dvh flex-col bg-[radial-gradient(circle_at_top,oklch(0.96_0.035_250),oklch(0.985_0.006_250)_42%,oklch(0.965_0.008_250))] text-foreground">
      <div className="mx-auto flex w-full max-w-[33rem] flex-1 flex-col items-center justify-center gap-6 px-5 py-10">
        <div className="flex items-center gap-3" aria-label="Osfo">
          <span className="grid size-14 place-items-center rounded-full bg-primary text-2xl font-black text-primary-foreground shadow-lg">
            O
          </span>
          <span className="text-3xl font-black tracking-tight">Osfo</span>
        </div>

        <div
          className="grid w-full max-w-[31rem] grid-cols-2 gap-2 rounded-xl border bg-background/90 p-1.5 shadow-sm"
          aria-label="Authentication method"
        >
          <Button
            aria-pressed={method === "credentials"}
            type="button"
            variant={method === "credentials" ? "default" : "ghost"}
            onClick={() => setMethod("credentials")}
          >
            Email and password
          </Button>
          <Button
            aria-pressed={method === "phone"}
            type="button"
            variant={method === "phone" ? "default" : "ghost"}
            onClick={() => setMethod("phone")}
          >
            SMS code
          </Button>
        </div>

        {method === "phone" ? (
          <PhoneAuthForm onAuthenticated={onAuthenticated} />
        ) : credentialMode === "sign-in" ? (
          <SignInForm
            onAuthenticated={onAuthenticated}
            onSwitchToSignUp={() => setCredentialMode("sign-up")}
          />
        ) : (
          <SignUpForm
            onAuthenticated={onAuthenticated}
            onSwitchToSignIn={() => setCredentialMode("sign-in")}
          />
        )}
      </div>
    </main>
  );
}
