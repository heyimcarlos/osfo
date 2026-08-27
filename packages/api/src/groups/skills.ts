import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

const SkillReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const SkillRevisionReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const PlainText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000));

/** Plain-language current availability without connection or entitlement internals. */
export const SkillAvailability = Schema.Union([
  Schema.Struct({ state: Schema.Literal("available") }),
  Schema.Struct({ explanation: PlainText, state: Schema.Literal("unavailable") }),
]);

/** Safe control-center projection of one current personal Skill. */
export const SkillSummary = Schema.Struct({
  availability: SkillAvailability,
  behavior: PlainText,
  canUndo: Schema.Boolean,
  capabilities: Schema.Array(PlainText).check(Schema.isMaxLength(24)),
  lastUsedAt: Schema.NullOr(Schema.DateFromString),
  purpose: PlainText,
  reference: SkillReference,
  revisionReference: SkillRevisionReference,
  status: Schema.Literals(["active", "archived"]),
});

export type SkillSummary = typeof SkillSummary.Type;

/** Authenticated User's current Skills, including archived Skills. */
export const SkillsSummary = Schema.Struct({ skills: Schema.Array(SkillSummary) });

export type SkillsSummary = typeof SkillsSummary.Type;

/** Non-destructive lifecycle changes accepted by the Skills control center. */
export const SkillChangeRequest = Schema.Union([
  Schema.Struct({
    change: Schema.Literal("archive"),
    expectedRevision: SkillRevisionReference,
    reference: SkillReference,
  }),
  Schema.Struct({
    change: Schema.Literal("restore"),
    expectedRevision: SkillRevisionReference,
    reference: SkillReference,
  }),
  Schema.Struct({
    change: Schema.Literal("undo"),
    expectedRevision: SkillRevisionReference,
    reference: SkillReference,
  }),
]);

export type SkillChangeRequest = typeof SkillChangeRequest.Type;

/** Compact visible result after one material Skill lifecycle change. */
export const SkillChangeResponse = Schema.Struct({ notice: PlainText, skill: SkillSummary });

export type SkillChangeResponse = typeof SkillChangeResponse.Type;

export const skillDeletionPresentationVersion = "personal-skill-delete-v1";
export const skillDeletionConfirmation = "delete-this-skill";

/** Exact server-owned destructive Skill presentation. */
export const SkillDeletionPresentation = Schema.Struct({
  actionId: PlainText,
  confirmation: Schema.Literal(skillDeletionConfirmation),
  consequence: Schema.Literal(
    "Permanently delete this Skill, its previous revisions, and its learning history.",
  ),
  expectedRevision: SkillRevisionReference,
  reference: SkillReference,
  title: PlainText,
  version: Schema.Literal(skillDeletionPresentationVersion),
});

export type SkillDeletionPresentation = typeof SkillDeletionPresentation.Type;

/** Exact User decision over one server-owned Skill deletion presentation. */
export const SkillDeletionRequest = Schema.Struct({
  approval: Schema.Struct({
    decision: Schema.Literal("approved"),
    presentation: SkillDeletionPresentation,
  }),
  confirmation: Schema.Literal(skillDeletionConfirmation),
});

export type SkillDeletionRequest = typeof SkillDeletionRequest.Type;

/** Safe response after an exact Skill lineage is deleted. */
export const SkillDeletionResponse = Schema.Struct({ status: Schema.Literal("deleted") });

export type SkillDeletionResponse = typeof SkillDeletionResponse.Type;

export class SkillNotFound extends Schema.TaggedError<SkillNotFound>()(
  "SkillNotFound",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class SkillConflict extends Schema.TaggedError<SkillConflict>()(
  "SkillConflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class SkillsUnavailable extends Schema.TaggedError<SkillsUnavailable>()(
  "SkillsUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Authenticated personal Skill inspection and lifecycle controls. */
export const SkillsGroup = HttpApiGroup.make("skills")
  .add(
    HttpApiEndpoint.get("inspect", "/v1/skills", {
      error: SkillsUnavailable,
      success: SkillsSummary,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description: "Show the authenticated User's current and archived Skills.",
          identifier: "skills.inspect",
          summary: "Inspect Skills",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("change", "/v1/skills/change", {
      error: [SkillConflict, SkillNotFound, SkillsUnavailable],
      payload: SkillChangeRequest,
      success: SkillChangeResponse,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description: "Archive, restore, or undo the latest material Skill change.",
          identifier: "skills.change",
          summary: "Change a Skill",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("presentDeletion", "/v1/skills/:reference/deletion-action", {
      error: [SkillNotFound, SkillsUnavailable],
      params: Schema.Struct({ reference: SkillReference }),
      success: SkillDeletionPresentation,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description: "Present the exact current Skill lineage that can be deleted.",
          identifier: "skills.delete.present",
          summary: "Present Skill deletion",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("delete", "/v1/skills/:reference", {
      error: [SkillConflict, SkillNotFound, SkillsUnavailable],
      params: Schema.Struct({ reference: SkillReference }),
      payload: SkillDeletionRequest,
      success: SkillDeletionResponse,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description: "Permanently delete one exact Skill lineage after explicit Approval.",
          identifier: "skills.delete",
          summary: "Delete a Skill",
        }),
      ),
  );
