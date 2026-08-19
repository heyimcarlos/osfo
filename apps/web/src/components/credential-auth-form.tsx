import { Button } from "@osfo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
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

/** Sign in a verified Phone Account that already has login credentials. */
export function CredentialAuthForm({ onAuthenticated }: CredentialAuthFormProps) {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [password, setPassword] = useState("");
  const [requestError, setRequestError] = useState<string>();

  const submit = () => {
    setIsSubmitting(true);
    setRequestError(undefined);
    const callbacks = {
      onError: () => {
        setIsSubmitting(false);
        setRequestError("The email or password is not correct.");
      },
      onSuccess: () => {
        setIsSubmitting(false);
        onAuthenticated();
      },
    };
    return authClient.signIn.email({ email, password }, callbacks);
  };

  return (
    <Card className="w-full max-w-[31rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
      <CardHeader className="gap-3 border-b-2 border-border pb-5">
        <p className="font-black text-xs uppercase tracking-[0.22em]">Linked account</p>
        <CardTitle className="text-4xl uppercase leading-none sm:text-5xl">Sign in</CardTitle>
        <CardDescription className="max-w-sm text-base font-medium leading-snug text-foreground/75">
          Use credentials that you added after phone verification. New accounts must start with an
          SMS code.
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
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value.trim())}
            />
          </div>
          <div className="space-y-2">
            <Label className="font-black uppercase" htmlFor="credential-password">
              Password
            </Label>
            <Input
              autoComplete="current-password"
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
            {isSubmitting ? "Working..." : "Sign in"}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
