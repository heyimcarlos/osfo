import { expect, it } from "@effect/vitest";
import { matchesSuppliedBrowserUrl } from "./browser-task";
it("accepts a sentence terminator without admitting a prefix or another destination", () => {
  const requested = "http://127.0.0.1:39271/book";
  expect(
    matchesSuppliedBrowserUrl(`Book at ${requested}. Prefer Tuesday morning.`, requested),
  ).toBe(true);
  expect(matchesSuppliedBrowserUrl(`Book at ${requested}, please.`, requested)).toBe(true);
  for (const supplied of [
    `${requested}/other.`,
    `${requested}?slot=1.`,
    "http://127.0.0.1:39272/book.",
    "http://other.example/book.",
  ])
    expect(matchesSuppliedBrowserUrl(`Book at ${supplied}`, requested)).toBe(false);
});
it("preserves exact meaningful URL punctuation and never strips query or fragment delimiters", () => {
  for (const requested of [
    "https://portal.example/book.",
    "https://portal.example/book;",
    "https://portal.example/book!",
    "https://portal.example/book?",
    "https://portal.example/book#",
    "https://portal.example/book?slot=1.",
  ])
    expect(matchesSuppliedBrowserUrl(`Open ${requested}`, requested)).toBe(true);
  expect(
    matchesSuppliedBrowserUrl("Open https://portal.example/book?", "https://portal.example/book"),
  ).toBe(false);
  expect(
    matchesSuppliedBrowserUrl("Open https://portal.example/book#", "https://portal.example/book"),
  ).toBe(false);
});
