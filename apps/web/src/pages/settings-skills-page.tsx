import type {
  SkillChangeRequest,
  SkillChangeResponse,
  SkillDeletionPresentation,
  SkillDeletionResponse,
  SkillSummary,
  SkillsSummary,
} from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import { GlassPanel } from "@osfo/ui/components/glass-panel";
import { Archive, CheckCircle2, RotateCcw, Sparkles, Trash2, Undo2 } from "lucide-react";
import { Effect, Schema } from "effect";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import { changeSkill, deleteSkill, inspectSkills, presentSkillDeletion } from "../lib/api-client";

export type SkillChangeIntent = SkillChangeRequest;

export class SettingsSkillsFailure extends Schema.TaggedError<SettingsSkillsFailure>()(
  "SettingsSkillsFailure",
  { message: Schema.String },
) {}

export interface SettingsSkillsDependencies {
  readonly change: (
    input: SkillChangeRequest,
  ) => Effect.Effect<SkillChangeResponse, SettingsSkillsFailure>;
  readonly delete: (
    presentation: SkillDeletionPresentation,
  ) => Effect.Effect<SkillDeletionResponse, SettingsSkillsFailure>;
  readonly inspect: Effect.Effect<SkillsSummary, SettingsSkillsFailure>;
  readonly presentDeletion: (
    reference: string,
  ) => Effect.Effect<SkillDeletionPresentation, SettingsSkillsFailure>;
}

const toSettingsSkillsFailure = () =>
  new SettingsSkillsFailure({ message: "The Skills authority request failed." });

const defaultDependencies: SettingsSkillsDependencies = {
  change: (input) => changeSkill(input).pipe(Effect.mapError(toSettingsSkillsFailure)),
  delete: (presentation) =>
    deleteSkill(presentation).pipe(Effect.mapError(toSettingsSkillsFailure)),
  inspect: inspectSkills.pipe(Effect.mapError(toSettingsSkillsFailure)),
  presentDeletion: (reference) =>
    presentSkillDeletion(reference).pipe(Effect.mapError(toSettingsSkillsFailure)),
};

/** Plain-language Skill cards rendered inside the authenticated Settings shell. */
export function SkillsSettingsContent({
  busyReference,
  notice,
  onChange,
  onDelete,
  skills,
}: {
  readonly busyReference: string | null;
  readonly notice: string | null;
  readonly onChange: (change: SkillChangeIntent) => void;
  readonly onDelete?: (skill: SkillSummary, trigger: HTMLButtonElement) => void;
  readonly skills: ReadonlyArray<SkillSummary>;
}) {
  if (skills.length === 0) {
    return (
      <GlassPanel className="grid min-h-80 place-items-center p-8 text-center">
        <div className="max-w-md">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-[#e8f1ff] text-[#2f7df4]">
            <Sparkles aria-hidden="true" className="size-7" />
          </span>
          <h2 className="mt-5 text-xl font-bold">No Skills yet</h2>
          <p className="mt-2 text-sm leading-6 text-[#687896]">
            Osfo will tell you when it learns a reusable preference. You can review and control it
            here.
          </p>
        </div>
      </GlassPanel>
    );
  }

  return (
    <div className="grid gap-4">
      {notice === null ? null : (
        <p className="rounded-2xl border border-[#b8d3ff] bg-[#edf4ff] p-4 text-sm" role="status">
          {notice}
        </p>
      )}
      <p className="text-sm leading-6 text-[#687896]">
        Skills are lasting preferences Osfo can use for matching work. Your current request always
        wins for the task at hand.
      </p>
      <ul className="grid gap-4" aria-label="Your Skills">
        {skills.map((skill) => {
          const busy = busyReference === skill.reference;
          const archived = skill.status === "archived";
          return (
            <li key={skill.reference}>
              <GlassPanel className="p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-bold">{skill.purpose}</h2>
                      <span className="rounded-full bg-white/70 px-2.5 py-1 text-xs font-semibold text-[#526684]">
                        {archived ? "Archived" : "Active"}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[#334563]">{skill.behavior}</p>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                      skill.availability.state === "available"
                        ? "bg-[#daf6e6] text-[#16784a]"
                        : "bg-amber-100 text-amber-900"
                    }`}
                  >
                    <CheckCircle2 aria-hidden="true" className="size-3.5" />
                    {skill.availability.state === "available" ? "Available" : "Unavailable"}
                  </span>
                </div>
                {skill.availability.state === "unavailable" ? (
                  <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">
                    {skill.availability.explanation}
                  </p>
                ) : null}
                <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="font-semibold">Can help with</dt>
                    <dd className="mt-1 text-[#687896]">{skill.capabilities.join(", ")}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold">Last used</dt>
                    <dd className="mt-1 text-[#687896]">
                      {skill.lastUsedAt === null
                        ? "Not used yet"
                        : new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" }).format(
                            skill.lastUsedAt,
                          )}
                    </dd>
                  </div>
                </dl>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    disabled={busy}
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      onChange({
                        change: archived ? "restore" : "archive",
                        expectedRevision: skill.revisionReference,
                        reference: skill.reference,
                      })
                    }
                  >
                    {archived ? (
                      <RotateCcw aria-hidden="true" className="size-4" />
                    ) : (
                      <Archive aria-hidden="true" className="size-4" />
                    )}
                    {archived ? "Restore" : "Archive"}
                  </Button>
                  <Button
                    disabled={busy}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      onChange({
                        change: "undo",
                        expectedRevision: skill.revisionReference,
                        reference: skill.reference,
                      })
                    }
                  >
                    <Undo2 aria-hidden="true" className="size-4" />
                    Undo latest change
                  </Button>
                  <Button
                    className="text-[#c9364d] hover:bg-[#fff0f2]"
                    disabled={busy || onDelete === undefined}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={(event) => onDelete?.(skill, event.currentTarget)}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                    Delete
                  </Button>
                </div>
              </GlassPanel>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Route-owned authenticated Skills settings page. */
export function SettingsSkillsPage({
  dependencies = defaultDependencies,
}: {
  readonly dependencies?: SettingsSkillsDependencies;
} = {}) {
  const [skills, setSkills] = useState<ReadonlyArray<SkillSummary> | null>(null);
  const [busyReference, setBusyReference] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<SkillDeletionPresentation | null>(null);
  const cancelDeletionRef = useRef<HTMLButtonElement>(null);
  const deletionTriggerRef = useRef<HTMLButtonElement>(null);
  const load = useCallback(() => {
    setError(null);
    void Effect.runPromise(dependencies.inspect).then(
      ({ skills: loaded }) => setSkills(loaded),
      () => setError("Skills are temporarily unavailable. Please try again."),
    );
  }, [dependencies]);
  useEffect(load, [load]);
  useEffect(() => {
    if (deletion !== null) cancelDeletionRef.current?.focus();
  }, [deletion]);

  const change = (input: SkillChangeIntent) => {
    setBusyReference(input.reference);
    setError(null);
    void Effect.runPromise(dependencies.change(input)).then(
      (result) => {
        setSkills(
          (current) =>
            current?.map((skill) =>
              skill.reference === result.skill.reference ? result.skill : skill,
            ) ?? [result.skill],
        );
        setNotice(result.notice);
        setBusyReference(null);
      },
      () => {
        setError("That Skill changed or is temporarily unavailable. Refresh and try again.");
        setBusyReference(null);
      },
    );
  };

  const presentDelete = (skill: SkillSummary, trigger: HTMLButtonElement) => {
    deletionTriggerRef.current = trigger;
    setBusyReference(skill.reference);
    setError(null);
    void Effect.runPromise(dependencies.presentDeletion(skill.reference)).then(
      (presentation) => {
        setDeletion(presentation);
        setBusyReference(null);
      },
      () => {
        setError("This Skill could not be prepared for deletion. Refresh and try again.");
        setBusyReference(null);
      },
    );
  };

  const confirmDelete = () => {
    if (deletion === null) return;
    setBusyReference(deletion.reference);
    setError(null);
    void Effect.runPromise(dependencies.delete(deletion)).then(
      () => {
        setSkills(
          (current) => current?.filter(({ reference }) => reference !== deletion.reference) ?? [],
        );
        setNotice("Skill permanently deleted.");
        setDeletion(null);
        setBusyReference(null);
      },
      () => {
        setError("This Skill changed or could not be deleted. Refresh and try again.");
        setDeletion(null);
        setBusyReference(null);
      },
    );
  };

  const closeDeletion = () => {
    setDeletion(null);
    queueMicrotask(() => deletionTriggerRef.current?.focus());
  };

  const containDeletionFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDeletion();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
    const first = buttons.item(0);
    const last = buttons.item(buttons.length - 1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  if (skills === null) {
    return (
      <div className="grid min-h-64 place-items-center text-center">
        <div>
          <p role={error === null ? undefined : "alert"}>{error ?? "Loading Skills..."}</p>
          {error === null ? null : (
            <Button className="mt-4" type="button" onClick={load}>
              Try again
            </Button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div>
      <div inert={deletion !== null}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-sm text-[#687896]">Review what Osfo has learned to do your way.</p>
          <Button size="sm" type="button" variant="ghost" onClick={load}>
            Refresh
          </Button>
        </div>
        {error === null ? null : (
          <p className="mb-4 rounded-xl bg-[#fff0f2] p-3 text-sm text-[#9e2639]" role="alert">
            {error}
          </p>
        )}
        <SkillsSettingsContent
          busyReference={busyReference}
          notice={notice}
          skills={skills}
          onChange={change}
          onDelete={presentDelete}
        />
      </div>
      {deletion === null ? null : (
        <div
          aria-labelledby="skill-delete-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[#101936]/45 p-4"
          role="dialog"
          onKeyDown={containDeletionFocus}
        >
          <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <h2 className="text-xl font-bold" id="skill-delete-title">
              {deletion.title}
            </h2>
            <p className="mt-3 text-sm leading-6 text-[#526684]">{deletion.consequence}</p>
            <p className="mt-3 text-sm font-semibold text-[#9e2639]">This cannot be undone.</p>
            <div className="mt-6 flex justify-end gap-2">
              <Button
                ref={cancelDeletionRef}
                type="button"
                variant="secondary"
                onClick={closeDeletion}
              >
                Cancel
              </Button>
              <Button
                className="bg-[#c9364d] text-white hover:bg-[#a92d41]"
                type="button"
                onClick={confirmDelete}
              >
                Delete permanently
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
