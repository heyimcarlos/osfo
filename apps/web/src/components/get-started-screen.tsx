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
import { Effect, Exit } from "effect";
import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { authClient } from "../lib/auth-client";
import { completeRegistration } from "../lib/api-client";
import { PhoneAuthForm } from "./phone-auth-form";

interface GetStartedScreenProps {
  readonly initialName?: string;
  readonly isAuthenticated?: boolean;
  readonly onComplete: () => void;
}

/** Public web entry for preferred-name capture and phone-first registration. */
export function GetStartedScreen({
  initialName = "",
  isAuthenticated = false,
  onComplete,
}: GetStartedScreenProps) {
  const [name, setName] = useState(initialName);
  const [nameConfirmed, setNameConfirmed] = useState(isAuthenticated);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<string>();

  const complete = () => {
    setIsSubmitting(true);
    setRequestError(undefined);

    return authClient.updateUser({ name: name.trim() }).then((updated) => {
      if (updated.error) {
        const message = updated.error.message || updated.error.statusText;
        setRequestError(message);
        setIsSubmitting(false);
        return message;
      }

      return Effect.runPromiseExit(completeRegistration).then((exit) => {
        if (Exit.isFailure(exit)) {
          const message = "Osfo could not complete registration. Please try again.";
          setRequestError(message);
          setIsSubmitting(false);
          return message;
        }

        setIsSubmitting(false);
        onComplete();
        return undefined;
      });
    });
  };

  return (
    <main className="flex min-h-dvh flex-col bg-[radial-gradient(circle_at_top,oklch(0.96_0.035_250),oklch(0.985_0.006_250)_42%,oklch(0.965_0.008_250))] text-foreground">
      <div className="mx-auto flex w-full max-w-[33rem] flex-1 flex-col items-center justify-center gap-6 px-5 py-10">
        <div className="flex items-center gap-3" aria-label="Osfo">
          <span className="grid size-14 place-items-center rounded-full bg-primary text-2xl font-black text-primary-foreground shadow-lg">
            O
          </span>
          <span className="text-3xl font-black tracking-tight">Osfo</span>
        </div>

        {nameConfirmed && !isAuthenticated ? (
          <PhoneAuthForm onAuthenticated={complete} />
        ) : (
          <Card className="w-full max-w-[31rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
            <CardHeader className="gap-3 border-b-2 border-border pb-5">
              <p className="font-black text-xs uppercase tracking-[0.22em]">Get started</p>
              <CardTitle className="text-4xl uppercase leading-none sm:text-5xl">
                What should Osfo call you?
              </CardTitle>
              <CardDescription className="text-base font-medium text-foreground/75">
                You are starting on Free. No card is required. You get 30 messages every 30 days.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (isAuthenticated) void complete();
                  else setNameConfirmed(true);
                }}
              >
                <div className="space-y-2">
                  <Label className="font-black uppercase" htmlFor="preferred-name">
                    Your name
                  </Label>
                  <Input
                    autoComplete="name"
                    id="preferred-name"
                    maxLength={80}
                    name="name"
                    required
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>

                {requestError ? (
                  <p className="text-sm font-medium text-destructive" role="alert">
                    {requestError}
                  </p>
                ) : null}

                <Button
                  className="h-10 w-full justify-between rounded-sm border-2 border-border font-black uppercase"
                  disabled={isSubmitting || name.trim().length === 0}
                  type="submit"
                >
                  {isSubmitting ? "Working..." : isAuthenticated ? "Complete setup" : "Continue"}
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
