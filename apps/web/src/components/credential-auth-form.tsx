import { Button } from "@osfo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@osfo/ui/components/card";
import { Input } from "@osfo/ui/components/input";
import { Label } from "@osfo/ui/components/label";
import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { authClient } from "../lib/auth-client";

interface CredentialAuthFormProps {
  readonly onAuthenticated: () => void;
}

/** Development-only email-and-password authentication form. */
export function CredentialAuthForm({ onAuthenticated }: CredentialAuthFormProps) {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [password, setPassword] = useState("");
  const [requestError, setRequestError] = useState<string>();
  const isSignIn = mode === "sign-in";

  const submit = () => {
    setIsSubmitting(true);
    setRequestError(undefined);
    const callbacks = {
      onError: ({
        error,
      }: {
        readonly error: { readonly message?: string; readonly statusText?: string };
      }) => {
        setIsSubmitting(false);
        setRequestError(error.message || error.statusText || "Authentication failed.");
      },
      onSuccess: () => {
        setIsSubmitting(false);
        onAuthenticated();
      },
    };

    if (isSignIn) return authClient.signIn.email({ email, password }, callbacks);

    return authClient.signUp.email(
      { email, name: email.split("@")[0] || "Osfo User", password },
      {
        ...callbacks,
        onSuccess: () => {
          void authClient.signIn.email({ email, password }, callbacks);
        },
      },
    );
  };

  return (
    <Card className="w-full max-w-[31rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
      <CardHeader className="gap-3 border-b-2 border-border pb-5">
        <p className="font-black text-xs uppercase tracking-[0.22em]">Development access</p>
        <CardTitle className="text-4xl uppercase leading-none sm:text-5xl">
          {isSignIn ? "Sign in" : "Create account"}
        </CardTitle>
        <CardDescription className="max-w-sm text-base font-medium leading-snug text-foreground/75">
          Use a local test account without sending an SMS.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-2">
            <Label className="font-black uppercase" htmlFor="credential-email">
              Email
            </Label>
            <Input
              autoComplete="email"
              id="credential-email"
              minLength={3}
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label className="font-black uppercase" htmlFor="credential-password">
              Password
            </Label>
            <Input
              autoComplete={isSignIn ? "current-password" : "new-password"}
              id="credential-password"
              minLength={8}
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {requestError === undefined ? null : (
            <p className="text-sm font-medium text-destructive" role="alert">
              {requestError}
            </p>
          )}

          <Button
            className="h-10 w-full justify-between rounded-sm border-2 border-border font-black uppercase"
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? "Working..." : isSignIn ? "Sign in" : "Create account"}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </form>
      </CardContent>

      <CardFooter className="justify-between gap-3">
        <p className="font-medium text-sm">
          {isSignIn ? "No test account yet?" : "Already have a test account?"}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setMode(isSignIn ? "sign-up" : "sign-in");
            setRequestError(undefined);
          }}
        >
          {isSignIn ? "Create account" : "Sign in"}
        </Button>
      </CardFooter>
    </Card>
  );
}
