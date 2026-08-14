import { useForm } from "@tanstack/react-form";
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
import { z } from "zod";

import { authClient } from "../lib/auth-client";
import { AuthFieldErrors } from "./auth-field-errors";

interface SignInFormProps {
  readonly onAuthenticated: () => void;
  readonly onSwitchToSignUp: () => void;
}

/** Temporary email-and-password sign-in form adapted from TryAgent. */
export function SignInForm({ onAuthenticated, onSwitchToSignUp }: SignInFormProps) {
  const [requestError, setRequestError] = useState<string>();
  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: ({ value }) => {
      setRequestError(undefined);
      return authClient.signIn.email(value, {
        onError: ({ error }) => setRequestError(error.message || error.statusText),
        onSuccess: onAuthenticated,
      });
    },
    validators: {
      onSubmit: z.object({
        email: z.email("Enter a valid email address"),
        password: z.string().min(8, "Password must be at least 8 characters"),
      }),
    },
  });

  return (
    <Card className="w-full max-w-[31rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
      <CardHeader className="gap-3 border-b-2 border-border pb-5">
        <p className="font-black text-xs uppercase tracking-[0.22em]">Welcome back</p>
        <CardTitle className="text-4xl uppercase leading-none sm:text-5xl">Sign in</CardTitle>
        <CardDescription className="max-w-sm text-base font-medium leading-snug text-foreground/75">
          Use a temporary test credential while Osfo authentication is under development.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.Field name="email">
            {(field) => (
              <div className="space-y-2">
                <Label className="font-black uppercase" htmlFor={field.name}>
                  Email
                </Label>
                <Input
                  autoComplete="email"
                  id={field.name}
                  name={field.name}
                  placeholder="you@example.com"
                  type="email"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <AuthFieldErrors errors={field.state.meta.errors} />
              </div>
            )}
          </form.Field>

          <form.Field name="password">
            {(field) => (
              <div className="space-y-2">
                <Label className="font-black uppercase" htmlFor={field.name}>
                  Password
                </Label>
                <Input
                  autoComplete="current-password"
                  id={field.name}
                  name={field.name}
                  placeholder="8 characters minimum"
                  type="password"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <AuthFieldErrors errors={field.state.meta.errors} />
              </div>
            )}
          </form.Field>

          {requestError ? (
            <p className="text-sm font-medium text-destructive" role="alert">
              {requestError}
            </p>
          ) : null}

          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
            {([canSubmit, isSubmitting]) => (
              <Button
                className="h-10 w-full justify-between rounded-sm border-2 border-border font-black uppercase"
                disabled={!canSubmit || isSubmitting}
                type="submit"
              >
                {isSubmitting ? "Signing in..." : "Sign in"}
                <ArrowRight data-icon="inline-end" />
              </Button>
            )}
          </form.Subscribe>
        </form>
      </CardContent>

      <CardFooter className="justify-between gap-3">
        <p className="font-medium text-sm">No account yet?</p>
        <Button type="button" variant="outline" onClick={onSwitchToSignUp}>
          Create account
        </Button>
      </CardFooter>
    </Card>
  );
}
