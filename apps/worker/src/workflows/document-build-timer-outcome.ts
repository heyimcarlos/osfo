import { DocumentBuild } from "../services/document-build";
import type { DocumentBuildFollowUp } from "../services/document-build-follow-up";

/* oxlint-disable eslint/no-underscore-dangle -- Follow-up outcomes use Effect's standard discriminator. */

export const postPreviewDisposition = (state: DocumentBuild.State) =>
  state === "publication_committed"
    ? ("recover" as const)
    : DocumentBuild.terminalStates.has(state)
      ? ("terminal" as const)
      : ("continue" as const);

export const previewFollowUpDisposition = (result: DocumentBuildFollowUp.SubmissionSuccess) =>
  result._tag === "TerminalSuperseded" ? ("terminal" as const) : ("accepted" as const);

export const terminalFollowUpAccepted = (result: DocumentBuildFollowUp.SubmissionSuccess) =>
  result._tag === "Accepted" || result._tag === "Replayed";
