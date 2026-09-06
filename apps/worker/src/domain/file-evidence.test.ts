/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effects returned to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import {
  checkFileFieldEvidence,
  FileFieldCandidate,
  FilePageEvidence,
  FilePagesEvidence,
} from "./file-evidence";

const pages = FilePagesEvidence.make([
  { page: 1, method: "native_text", text: "Agreement date: 04/05/2026. Fee: $200." },
  { page: 2, method: "ocr", text: "Revised fee: $250." },
  { page: 3, method: "ocr", text: "" },
]);

it("preserves exact date literals and evidence without converting them", () => {
  const candidate = FileFieldCandidate.make({
    value: "04/05/2026",
    evidence: [{ page: 1, quote: "Agreement date: 04/05/2026." }],
  });
  expect(
    checkFileFieldEvidence(pages, { field: "agreement date", candidates: [candidate] }),
  ).toEqual({
    field: "agreement date",
    status: "known",
    value: "04/05/2026",
    candidates: [{ ...candidate, status: "supported" }],
  });
});

it("retains conflicting supported values and all their page evidence", () => {
  const candidates = [
    { value: "$200", evidence: [{ page: 1, quote: "Fee: $200." }] },
    { value: "$250", evidence: [{ page: 2, quote: "Revised fee: $250." }] },
  ];
  expect(checkFileFieldEvidence(pages, { field: "fee", candidates })).toEqual({
    field: "fee",
    status: "conflicting",
    values: ["$200", "$250"],
    candidates: candidates.map((candidate) => ({
      value: candidate.value,
      evidence: candidate.evidence,
      status: "supported",
    })),
  });
});

it("does not count repeated support for the same literal as a conflict", () => {
  const candidate = { value: "$200", evidence: [{ page: 1, quote: "Fee: $200." }] };
  expect(
    checkFileFieldEvidence(pages, { field: "fee", candidates: [candidate, candidate] }),
  ).toMatchObject({
    status: "known",
    value: "$200",
  });
});

it("keeps absent fields unknown", () => {
  expect(checkFileFieldEvidence(pages, { field: "guarantor", candidates: [] })).toEqual({
    field: "guarantor",
    status: "unknown",
    candidates: [],
  });
});

it.each([
  { value: "$200", evidence: [], reason: "no_evidence" },
  { value: "$200", evidence: [{ page: 4, quote: "Fee: $200." }], reason: "page_unavailable" },
  { value: "$200", evidence: [{ page: 3, quote: "Fee: $200." }], reason: "quote_not_found" },
  { value: "$200", evidence: [{ page: 2, quote: "Fee: $200." }], reason: "quote_not_found" },
  { value: "$250", evidence: [{ page: 1, quote: "Fee: $200." }], reason: "value_not_in_quote" },
  {
    value: "2026-04-05",
    evidence: [{ page: 1, quote: "Agreement date: 04/05/2026." }],
    reason: "value_not_in_quote",
  },
])("rejects unsupported candidates with $reason", ({ reason, ...candidate }) => {
  expect(
    checkFileFieldEvidence(pages, { field: "requested field", candidates: [candidate] }),
  ).toEqual({
    field: "requested field",
    status: "unknown",
    candidates: [{ ...candidate, status: "unsupported", reason }],
  });
});

it("does not discard unsupported quotes or competing candidates to declare a known value", () => {
  const supported = { value: "$200", evidence: [{ page: 1, quote: "Fee: $200." }] };
  const unsupported = { value: "$250", evidence: [{ page: 1, quote: "Fee: $250." }] };
  expect(
    checkFileFieldEvidence(pages, { field: "fee", candidates: [supported, unsupported] }).status,
  ).toBe("unknown");
  expect(
    checkFileFieldEvidence(pages, {
      field: "fee",
      candidates: [
        { ...supported, evidence: [...supported.evidence, { page: 2, quote: "Fee: $200." }] },
      ],
    }).status,
  ).toBe("unknown");
});

it("requires unambiguous retained page identity", () => {
  expect(
    checkFileFieldEvidence([...pages, { page: 1, method: "ocr", text: "Fee: $200." }], {
      field: "fee",
      candidates: [{ value: "$200", evidence: [{ page: 1, quote: "Fee: $200." }] }],
    }),
  ).toMatchObject({ status: "unknown", candidates: [{ reason: "page_unavailable" }] });
});

it.effect("decodes only positive integer page identities and bounded evidence", () =>
  Effect.gen(function* () {
    for (const page of [0, -1, 1.5]) {
      const result = yield* Schema.decodeEffect(FilePageEvidence)({
        page,
        method: "ocr",
        text: "",
      }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }
    const oversized = yield* Schema.decodeUnknownEffect(FilePagesEvidence)(
      Array.from({ length: 501 }, (_, index) => ({ page: index + 1, method: "ocr", text: "" })),
    ).pipe(Effect.result);
    expect(Result.isFailure(oversized)).toBe(true);
  }),
);
