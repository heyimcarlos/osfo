declare const identityRole: unique symbol;

type Identity<Role extends string> = string & { readonly [identityRole]: Role };

/** Parsed corpus case identity. */
export type CaseId = Identity<"CaseId">;

/** Parsed human or safety approval identity. */
export type ApprovalId = Identity<"ApprovalId">;

/** Parsed immutable corpus or label-set version identity. */
export type VersionId = Identity<"VersionId">;

/** Parsed canonical UTC evidence instant. */
export type EvidenceInstant = Identity<"EvidenceInstant">;

/** Parsed release identity. */
export type ReleaseId = Identity<"ReleaseId">;

/** Parsed evaluation manifest identity. */
export type EvaluationManifestId = Identity<"EvaluationManifestId">;

/** Expected identity parsing failure. */
export type InvalidIdentity = {
  readonly _tag: "InvalidIdentity";
  readonly identity: "approval" | "case" | "instant" | "manifest" | "release" | "version";
};

/** Result of parsing a domain identity. */
export type IdentityResult<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly error: InvalidIdentity; readonly kind: "error" };

/** Parse a corpus case identity. */
export const parseCaseId = (input: string): IdentityResult<CaseId> =>
  parseNonEmptyIdentity<CaseId>(input, "case");

/** Parse an approval identity. */
export const parseApprovalId = (input: string): IdentityResult<ApprovalId> =>
  parseNonEmptyIdentity<ApprovalId>(input, "approval");

/** Parse a corpus or evidence version identity. */
export const parseVersionId = (input: string): IdentityResult<VersionId> =>
  parseNonEmptyIdentity<VersionId>(input, "version");

/** Parse a release identity. */
export const parseReleaseId = (input: string): IdentityResult<ReleaseId> =>
  parseNonEmptyIdentity<ReleaseId>(input, "release");

/** Parse an evaluation manifest identity. */
export const parseEvaluationManifestId = (input: string): IdentityResult<EvaluationManifestId> =>
  parseNonEmptyIdentity<EvaluationManifestId>(input, "manifest");

/** Parse a canonical millisecond-precision UTC instant. */
export const parseEvidenceInstant = (input: string): IdentityResult<EvidenceInstant> => {
  const match =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})\.(?<millisecond>\d{3})Z$/.exec(
      input,
    );
  const epoch = Date.parse(input);
  if (
    match?.groups === undefined ||
    !Number.isFinite(epoch) ||
    !utcComponentsAreValid(match.groups)
  ) {
    return { error: { _tag: "InvalidIdentity", identity: "instant" }, kind: "error" };
  }
  // SAFETY: The round-trip above proves this is one canonical UTC instant.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: TypeScript cannot represent the private identity brand.
  return { kind: "success", value: input as EvidenceInstant };
};

const utcComponentsAreValid = (parts: Record<string, string>): boolean => {
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const millisecond = Number(parts.millisecond);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59 &&
    millisecond >= 0 &&
    millisecond <= 999
  );
};

const parseNonEmptyIdentity = <T extends string>(
  input: string,
  identity: Exclude<InvalidIdentity["identity"], "instant">,
): IdentityResult<T> => {
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(input)) {
    return { error: { _tag: "InvalidIdentity", identity }, kind: "error" };
  }
  // SAFETY: The parser accepts one non-empty, delimiter-safe identity and owns the matching role.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: TypeScript cannot produce a role brand from the parser argument.
  return { kind: "success", value: input as T };
};
