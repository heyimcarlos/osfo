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

interface PhoneAuthFormProps {
  readonly onAuthenticated: () => Promise<string | undefined> | string | undefined | void;
}

/** Phone verification form backed by Twilio Verify. */
export function PhoneAuthForm({ onAuthenticated }: PhoneAuthFormProps) {
  const [code, setCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [requestError, setRequestError] = useState<string>();
  const [stage, setStage] = useState<"code" | "phone">("phone");

  const submitPhoneNumber = () => {
    setRequestError(undefined);
    setIsSubmitting(true);
    return authClient.phoneNumber.sendOtp({ phoneNumber }).then((result) => {
      if (result.error) {
        setRequestError(result.error.message || result.error.statusText);
        setIsSubmitting(false);
        return;
      }
      setIsSubmitting(false);
      setStage("code");
      return;
    });
  };

  const submitCode = () => {
    setRequestError(undefined);
    setIsSubmitting(true);
    return authClient.phoneNumber.verify({ code, phoneNumber }).then((result) => {
      if (result.error) {
        setRequestError(result.error.message || result.error.statusText);
        setIsSubmitting(false);
        return Promise.resolve();
      }
      return Promise.resolve(onAuthenticated()).then((error) => {
        if (error !== undefined) {
          setRequestError(error);
        }
        setIsSubmitting(false);
      });
    });
  };

  const codeWasSent = stage === "code";

  return (
    <Card className="w-full max-w-[31rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
      <CardHeader className="gap-3 border-b-2 border-border pb-5">
        <p className="font-black text-xs uppercase tracking-[0.22em]">Phone verification</p>
        <CardTitle className="text-4xl uppercase leading-none sm:text-5xl">
          {codeWasSent ? "Enter code" : "Continue by SMS"}
        </CardTitle>
        <CardDescription className="max-w-sm text-base font-medium leading-snug text-foreground/75">
          {codeWasSent
            ? `Enter the six-digit code sent to ${phoneNumber}.`
            : "Enter an E.164 phone number, including its country code."}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (codeWasSent) void submitCode();
            else void submitPhoneNumber();
          }}
        >
          <div className="space-y-2">
            <Label className="font-black uppercase" htmlFor="phone-number">
              Phone number
            </Label>
            <Input
              autoComplete="tel"
              disabled={codeWasSent || isSubmitting}
              id="phone-number"
              inputMode="tel"
              name="phoneNumber"
              placeholder="+14165550123"
              required
              type="tel"
              value={phoneNumber}
              onChange={(event) => setPhoneNumber(event.target.value)}
            />
          </div>

          {codeWasSent ? (
            <div className="space-y-2">
              <Label className="font-black uppercase" htmlFor="verification-code">
                Verification code
              </Label>
              <Input
                autoComplete="one-time-code"
                id="verification-code"
                inputMode="numeric"
                maxLength={6}
                name="code"
                pattern="[0-9]{6}"
                placeholder="123456"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
          ) : null}

          {requestError ? (
            <p className="text-sm font-medium text-destructive" role="alert">
              {requestError}
            </p>
          ) : null}

          <Button
            className="h-10 w-full justify-between rounded-sm border-2 border-border font-black uppercase"
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? "Working..." : codeWasSent ? "Verify and continue" : "Send code"}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </form>
      </CardContent>

      {codeWasSent ? (
        <CardFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setCode("");
              setRequestError(undefined);
              setStage("phone");
            }}
          >
            Use another number
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
