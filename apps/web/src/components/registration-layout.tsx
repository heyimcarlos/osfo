import { Label } from "@osfo/ui/components/label";
import type { ReactNode } from "react";

import { useDocumentLanguage } from "../lib/document-language";

/** Shared visual frame for public registration. */
export function RegistrationLayout({
  children,
  locale,
  onLocaleChange,
}: {
  readonly children: ReactNode;
  readonly locale: "en" | "es";
  readonly onLocaleChange: (locale: "en" | "es") => void;
}) {
  useDocumentLanguage(locale);

  return (
    <main className="flex min-h-dvh flex-col bg-[radial-gradient(circle_at_top,oklch(0.96_0.035_250),oklch(0.985_0.006_250)_42%,oklch(0.965_0.008_250))] text-foreground">
      <div className="mx-auto flex w-full max-w-[36rem] flex-1 flex-col items-center justify-center gap-6 px-5 py-10">
        <div className="flex w-full items-center justify-between gap-4">
          <div aria-label="Osfo" className="flex items-center gap-3">
            <span className="grid size-14 place-items-center rounded-full bg-primary text-2xl font-black text-primary-foreground shadow-lg">
              O
            </span>
            <span className="text-3xl font-black tracking-tight">Osfo</span>
          </div>
          <Label className="sr-only" htmlFor="registration-language">
            Language
          </Label>
          <select
            className="min-h-11 rounded-md border-2 border-border bg-background px-3 font-bold"
            id="registration-language"
            value={locale}
            onChange={(event) => onLocaleChange(event.target.value === "es" ? "es" : "en")}
          >
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        </div>
        {children}
      </div>
    </main>
  );
}

/** Choose the initial registration language from the browser. */
export const browserRegistrationLocale = (): "en" | "es" =>
  globalThis.navigator?.language.toLowerCase().startsWith("es") ? "es" : "en";
