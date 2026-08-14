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

interface SignUpFormProps {
  readonly onAuthenticated: () => void;
  readonly onSwitchToSignIn: () => void;
}

/** Temporary email-and-password account creation form adapted from TryAgent. */
export function SignUpForm({ onAuthenticated, onSwitchToSignIn }: SignUpFormProps) {
  const [requestError, setRequestError] = useState<string>();
  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: ({ value }) => {
      const fallbackName = value.email.split("@")[0] || "Osfo User";
      setRequestError(undefined);
      return authClient.signUp.email(
        { ...value, name: fallbackName },
        {
          onError: ({ error }) => setRequestError(error.message || error.statusText),
          onSuccess: onAuthenticated,
        },
      );
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
        <p className="font-black text-xs uppercase tracking-[0.22em]">Development access</p>
        <CardTitle className="text-4xl uppercase leading-none sm:text-5xl">
          Create account
        </CardTitle>
        <CardDescription className="max-w-sm text-base font-medium leading-snug text-foreground/75">
          Create a test account now. Osfo will use phone verification at launch.
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
                  autoComplete="new-password"
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
                {isSubmitting ? "Creating account..." : "Create account"}
                <ArrowRight data-icon="inline-end" />
              </Button>
            )}
          </form.Subscribe>
        </form>
      </CardContent>

      <CardFooter className="justify-between gap-3">
        <p className="font-medium text-sm">Already have an account?</p>
        <Button type="button" variant="outline" onClick={onSwitchToSignIn}>
          Sign in
        </Button>
      </CardFooter>
    </Card>
  );
}
