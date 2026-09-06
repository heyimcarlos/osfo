import { Schema } from "effect";

export const FilePageEvidence = Schema.Struct({
  page: Schema.Int.check(Schema.isGreaterThan(0)),
  method: Schema.Literals(["native_text", "ocr", "native_text_and_ocr"]),
  text: Schema.String,
});

export interface FilePageEvidence extends Schema.Schema.Type<typeof FilePageEvidence> {}

export const FilePagesEvidence = Schema.Array(FilePageEvidence).check(Schema.isMaxLength(500));

export const FileFieldCandidate = Schema.Struct({
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
  evidence: Schema.Array(
    Schema.Struct({
      page: FilePageEvidence.fields.page,
      quote: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
    }),
  ).check(Schema.isMaxLength(8)),
});

export interface FileFieldCandidate extends Schema.Schema.Type<typeof FileFieldCandidate> {}

export const FileFieldRequest = Schema.Struct({
  field: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  candidates: Schema.Array(FileFieldCandidate).check(Schema.isMaxLength(16)),
});

export interface FileFieldRequest extends Schema.Schema.Type<typeof FileFieldRequest> {}

type CheckedCandidate = FileFieldCandidate &
  (
    | { readonly status: "supported" }
    | {
        readonly status: "unsupported";
        readonly reason:
          | "no_evidence"
          | "page_unavailable"
          | "quote_not_found"
          | "value_not_in_quote";
      }
  );

export type FileFieldEvidenceResult = {
  readonly field: string;
  readonly candidates: ReadonlyArray<CheckedCandidate>;
} & (
  | { readonly status: "known"; readonly value: string }
  | { readonly status: "unknown" }
  | { readonly status: "conflicting"; readonly values: ReadonlyArray<string> }
);

/** Checks literal support only. Field meaning and OCR accuracy still need review in page context. */
export const checkFileFieldEvidence = (
  pages: ReadonlyArray<FilePageEvidence>,
  request: FileFieldRequest,
): FileFieldEvidenceResult => {
  const candidates = request.candidates.map((candidate): CheckedCandidate => {
    if (candidate.evidence.length === 0) {
      return { ...candidate, status: "unsupported", reason: "no_evidence" };
    }
    const rejection = candidate.evidence.flatMap((evidence) => {
      const matchingPages = pages.filter((page) => page.page === evidence.page);
      const page = matchingPages[0];
      if (matchingPages.length !== 1 || page === undefined) return ["page_unavailable" as const];
      if (!page.text.includes(evidence.quote)) return ["quote_not_found" as const];
      if (!evidence.quote.includes(candidate.value)) return ["value_not_in_quote" as const];
      return [];
    })[0];
    if (rejection !== undefined) return { ...candidate, status: "unsupported", reason: rejection };
    return { ...candidate, status: "supported" };
  });
  const result = { field: request.field, candidates };
  if (
    candidates.length === 0 ||
    candidates.some((candidate) => candidate.status === "unsupported")
  ) {
    return { ...result, status: "unknown" };
  }
  const values = [...new Set(candidates.map((candidate) => candidate.value))];
  const value = values[0];
  if (value === undefined) return { ...result, status: "unknown" };
  if (values.length > 1) return { ...result, status: "conflicting", values };
  return { ...result, status: "known", value };
};
