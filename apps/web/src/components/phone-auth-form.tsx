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
import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";

import { authClient } from "../lib/auth-client";

/* oxlint-disable effecttsgo/global-timers -- React owns this visible resend countdown lifecycle. */

/** Browser authentication operations used by the Phone Verification form. */
export interface PhoneAuthDependencies {
  readonly sendCode: (input: {
    readonly phoneNumber: string;
  }) => Promise<{ readonly error: unknown }>;
  readonly verifyCode: (input: {
    readonly code: string;
    readonly phoneNumber: string;
  }) => Promise<{ readonly error: unknown }>;
}

interface PhoneAuthFormProps {
  readonly dependencies?: PhoneAuthDependencies;
  readonly initialPhoneNumber?: string;
  readonly locale?: "en" | "es";
  readonly onAuthenticated: () => Promise<string | undefined> | string | undefined | void;
}

/** Phone verification form backed by Twilio Verify. */
export function PhoneAuthForm({
  dependencies = defaultPhoneAuthDependencies,
  initialPhoneNumber = "",
  locale = "en",
  onAuthenticated,
}: PhoneAuthFormProps) {
  const [code, setCode] = useState("");
  const [country, setCountry] = useState<CountryCode>("CA");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState(initialPhoneNumber);
  const [requestError, setRequestError] = useState<string>();
  const [resendSeconds, setResendSeconds] = useState(0);
  const [stage, setStage] = useState<"code" | "phone">("phone");
  const text = phoneText[locale];

  useEffect(() => {
    if (resendSeconds <= 0) return undefined;
    const timer = globalThis.setInterval(() => {
      setResendSeconds((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => globalThis.clearInterval(timer);
  }, [resendSeconds]);

  const submitPhoneNumber = () => {
    setRequestError(undefined);
    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber, country);
    if (normalizedPhoneNumber === null) {
      setRequestError(text.invalidPhone);
      return Promise.resolve();
    }
    setIsSubmitting(true);
    const submittedPhoneNumber = normalizedPhoneNumber ?? phoneNumber;
    return dependencies.sendCode({ phoneNumber: submittedPhoneNumber }).then((result) => {
      if (result.error) {
        setRequestError(text.sendError);
        setIsSubmitting(false);
        return;
      }
      setIsSubmitting(false);
      setResendSeconds(30);
      setStage("code");
      return;
    });
  };

  const submitCode = () => {
    setRequestError(undefined);
    setIsSubmitting(true);
    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber, country);
    const submittedPhoneNumber = normalizedPhoneNumber ?? phoneNumber;
    return dependencies.verifyCode({ code, phoneNumber: submittedPhoneNumber }).then((result) => {
      if (result.error) {
        setRequestError(text.verifyError);
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
        <p className="font-black text-xs uppercase tracking-[0.22em]">{text.eyebrow}</p>
        <CardTitle className="text-4xl uppercase leading-none sm:text-5xl">
          {codeWasSent ? text.enterCode : text.continueSms}
        </CardTitle>
        <CardDescription className="max-w-sm text-base font-medium leading-snug text-foreground/75">
          {codeWasSent ? `${text.codeSent} ${phoneNumber}.` : text.phoneHelp}
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
              {text.phoneLabel}
            </Label>
            <div className="grid gap-2 sm:grid-cols-[minmax(9rem,0.8fr)_1.2fr]">
              <div className="space-y-2">
                <Label className="sr-only" htmlFor="phone-country">
                  {text.countryLabel}
                </Label>
                <select
                  className="min-h-10 w-full rounded-md border-2 border-border bg-background px-3"
                  disabled={codeWasSent || isSubmitting}
                  id="phone-country"
                  value={country}
                  onChange={(event) => {
                    if (!isCountryCode(event.target.value)) return;
                    setCountry(event.target.value);
                    setPhoneNumber("");
                  }}
                >
                  {countryOptions(locale).map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <Input
                autoComplete="tel-national"
                disabled={codeWasSent || isSubmitting}
                id="phone-number"
                inputMode="tel"
                name="phoneNumber"
                placeholder={text.phonePlaceholder}
                required
                type="tel"
                value={phoneNumber}
                onChange={(event) =>
                  setPhoneNumber(new AsYouType(country).input(event.target.value))
                }
              />
            </div>
          </div>

          {codeWasSent ? (
            <div className="space-y-2">
              <Label className="font-black uppercase" htmlFor="verification-code">
                {text.codeLabel}
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
            {isSubmitting ? text.working : codeWasSent ? text.verify : text.sendCode}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </form>
      </CardContent>

      {codeWasSent ? (
        <CardFooter className="flex-wrap gap-3">
          <Button
            disabled={isSubmitting || resendSeconds > 0}
            type="button"
            variant="outline"
            onClick={() => void submitPhoneNumber()}
          >
            {resendSeconds > 0 ? `${text.resendIn} ${resendSeconds}s` : text.resend}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setCode("");
              setRequestError(undefined);
              setStage("phone");
            }}
          >
            {text.otherNumber}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** Production Phone Verification operations backed by Better Auth. */
export const defaultPhoneAuthDependencies: PhoneAuthDependencies = {
  sendCode: ({ phoneNumber }) => authClient.phoneNumber.sendOtp({ phoneNumber }),
  verifyCode: ({ code, phoneNumber }) => authClient.phoneNumber.verify({ code, phoneNumber }),
};

const phoneText = {
  en: {
    codeLabel: "Verification code",
    codeSent: "Enter the six-digit code sent to",
    continueSms: "Continue by SMS",
    enterCode: "Enter code",
    eyebrow: "Phone verification",
    invitedNumber: "Send a code to the invited number",
    countryLabel: "Country or region",
    invalidPhone: "Enter a valid international phone number.",
    otherNumber: "Use another number",
    phoneHelp: "Choose your country or region, then enter your phone number.",
    phoneLabel: "Phone number",
    phonePlaceholder: "(416) 555-0123",
    resend: "Resend code",
    resendIn: "Resend in",
    sendCode: "Send code",
    sendError: "We could not send a code. Check the number or wait before trying again.",
    verify: "Verify and continue",
    verifyError: "That code could not be verified. Try again or request a new code.",
    working: "Working...",
  },
  es: {
    codeLabel: "Código de verificación",
    codeSent: "Escribe el código de seis dígitos enviado a",
    continueSms: "Continuar por SMS",
    enterCode: "Escribe el código",
    eyebrow: "Verificación del teléfono",
    invitedNumber: "Envía un código al número invitado",
    countryLabel: "País o región",
    invalidPhone: "Escribe un número de teléfono internacional válido.",
    otherNumber: "Usar otro número",
    phoneHelp: "Elige tu país o región y escribe tu número de teléfono.",
    phoneLabel: "Número de teléfono",
    phonePlaceholder: "612 34 56 78",
    resend: "Reenviar código",
    resendIn: "Reenviar en",
    sendCode: "Enviar código",
    sendError: "No pudimos enviar el código. Revisa el número o espera antes de intentarlo.",
    verify: "Verificar y continuar",
    verifyError: "No pudimos verificar el código. Inténtalo de nuevo o pide otro código.",
    working: "Procesando...",
  },
} as const;

const normalizePhoneNumber = (input: string, country: CountryCode): string | null => {
  const parsed = parsePhoneNumberFromString(input, country);
  return parsed?.isValid() === true ? parsed.number : null;
};

const countryOptions = (locale: "en" | "es") => {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  return getCountries().map((code) => ({
    code,
    label: `${names.of(code) ?? code} (+${getCountryCallingCode(code)})`,
  }));
};

const isCountryCode = (value: string): value is CountryCode =>
  getCountries().some((country) => country === value);
