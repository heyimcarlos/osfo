import { closedCapabilityIds, type CapabilityId } from "../domain/capability-catalog";
import type { TaskKind } from "./capabilities";

type CapabilityIntentPredicate = (task: string) => boolean;

interface CapabilityIntentPolicy {
  readonly matches: CapabilityIntentPredicate;
  readonly taskKinds: ReadonlyArray<TaskKind>;
}

const normalizeIntentText = (text: string): string =>
  text
    .toLocaleLowerCase("en")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export const includesIntentPhrase = (text: string, phrase: string): boolean =>
  ` ${normalizeIntentText(text)} `.includes(` ${normalizeIntentText(phrase)} `);

const anyIntentPhrase =
  (...phrases: ReadonlyArray<string>): CapabilityIntentPredicate =>
  (task) =>
    phrases.some((phrase) => includesIntentPhrase(task, phrase));

const excludingIntentPhrases =
  (
    predicate: CapabilityIntentPredicate,
    ...phrases: ReadonlyArray<string>
  ): CapabilityIntentPredicate =>
  (task) =>
    predicate(task) && !phrases.some((phrase) => includesIntentPhrase(task, phrase));

const everyIntentGroup =
  (...groups: ReadonlyArray<ReadonlyArray<string>>): CapabilityIntentPredicate =>
  (task) =>
    groups.every((phrases) => phrases.some((phrase) => includesIntentPhrase(task, phrase)));

const matchesClosedIntent =
  (...patterns: ReadonlyArray<RegExp>): CapabilityIntentPredicate =>
  (task) =>
    patterns.some((pattern) => pattern.test(normalizeIntentText(task)));

/** Exact launch-only intent that keeps destructive and data-rights help reachable after exhaustion. */
export const isDeletionOrDataRightsIntent: CapabilityIntentPredicate = (task) => {
  const normalized = normalizeIntentText(task).replace(
    /^(?:(?:like|okay|ok|so|um|uh|well|yeah) )+/,
    "",
  );
  return [
    /^(?:(?:can|could|would|will) you (?:please )?(?:just )?|how do i |i (?:need|want|would like) (?:you )?to |please (?:just )?|just )?(?:clear|delete|erase|forget|remove|wipe) (?:all (?:of )?)?(?:(?:my|the|this|that) )?(?:account|chat history|conversation|conversation history|current session|data|memories|memory|remembered knowledge|session)(?:(?: for me| now| permanently| please))*$/,
    /^(?:(?:can|could|would|will) you (?:please )?(?:just )?|how do i |i (?:need|want|would like) (?:you )?to |please (?:just )?|just )?(?:clear|delete|erase|forget|remove|wipe) (?:(?:all (?:of )?)?(?:(?:my|the|your) )?(?:knowledge|memories|memory) (?:about|of) me|(?:everything|what) (?:that )?you (?:know|remember) about me|everything about me)(?:(?: for me| now| permanently| please))*$/,
    /^(?:(?:can|could|would|will) you (?:please )?|how do i |i (?:need|want|would like) to |please )?(?:exercise|request) (?:my )?(?:data rights|privacy rights)(?:(?: now| please))*$/,
  ].some((pattern) => pattern.test(normalized));
};

const matchesSessionDeleteIntent = matchesClosedIntent(
  /^(?:(?:can|could|would|will) you (?:please )?(?:just )?|i (?:need|want|would like) (?:you )?to |please (?:just )?|just )?(?:clear|delete|erase|remove|wipe) (?:all (?:of )?)?(?:(?:my|the|this|that) )?(?:chat history|conversation history|current session|session)(?:(?: for me| now| permanently| please))*$/,
);

const matchesSessionRecallIntent = anyIntentPhrase(
  "did i tell you",
  "do you remember",
  "earlier",
  "history",
  "last time",
  "last week",
  "previous conversation",
  "previous session",
  "recall",
  "told you",
  "what did i mention",
  "what did i say",
  "what did we discuss",
  "what did we talk about",
  "what i said",
  "what i told you",
  "what were we talking about",
);

export const capabilityIntentPolicy = {
  conversation: { matches: () => true, taskKinds: ["conversation"] },
  "core-memory": {
    matches: anyIntentPhrase(
      "note that",
      "do not forget that",
      "don't forget that",
      "i prefer",
      "i am allergic",
      "i live in",
      "i work at",
      "my favorite",
      "my favourite",
      "my name is",
      "remember my",
      "remember that",
      "remember this",
      "save this",
      "update memory",
    ),
    taskKinds: ["memory"],
  },
  "memory-clear": {
    matches: excludingIntentPhrases(
      anyIntentPhrase("clear memory", "delete memory", "forget that", "forget this"),
      "do not forget that",
      "don't forget that",
    ),
    taskKinds: ["memory"],
  },
  "knowledge-forget": {
    matches: everyIntentGroup(
      ["delete", "erase", "forget", "remove", "wipe"],
      [
        "knowledge",
        "memories",
        "memory",
        "remembered knowledge",
        "remember about me",
        "what you know about me",
        "everything you know about me",
        "what you remember about me",
        "everything you remember about me",
        "everything about me",
      ],
    ),
    taskKinds: ["memory"],
  },
  "session-delete": {
    matches: matchesSessionDeleteIntent,
    taskKinds: ["memory"],
  },
  "session-recall": {
    matches: (task) => !matchesSessionDeleteIntent(task) && matchesSessionRecallIntent(task),
    taskKinds: ["memory"],
  },
  "file-read": {
    matches: excludingIntentPhrases(
      anyIntentPhrase("attachment", "open", "read"),
      "calendar",
      "document",
      "docx",
      "drive",
      "email",
      "gmail",
      "link",
      "page",
      "pdf",
      "url",
      "website",
    ),
    taskKinds: ["file"],
  },
  "file-analysis": {
    matches: (task) =>
      anyIntentPhrase(
        "analyse",
        "analyze",
        "analysis",
        "check analysis",
        "inspect data",
        "reconcile",
      )(task) || everyIntentGroup(["summarize"], ["file", "spreadsheet"])(task),
    taskKinds: ["file"],
  },
  "document-generation": {
    matches: everyIntentGroup(
      ["create", "draft", "generate", "make", "write"],
      ["document", "docx", "pdf", "report"],
    ),
    taskKinds: ["document"],
  },
  "document-build": {
    matches: (task) =>
      (everyIntentGroup(
        ["build", "convert", "create", "generate", "make"],
        ["document", "docx", "file", "pdf"],
      )(task) &&
        anyIntentPhrase("from file", "from my file", "using file", "uploaded file")(task)) ||
      anyIntentPhrase("inspect document build", "document build status")(task),
    taskKinds: ["document", "workflow"],
  },
  "document-read": {
    matches: everyIntentGroup(["download", "export", "open", "read"], ["document", "docx", "pdf"]),
    taskKinds: ["document"],
  },
  "document-delete": {
    matches: everyIntentGroup(["delete", "remove"], ["document", "docx", "pdf"]),
    taskKinds: ["document"],
  },
  "artifact-read": {
    matches: everyIntentGroup(
      ["download", "export", "open", "read"],
      ["artifact", "deck", "diagram", "image", "pptx", "presentation"],
    ),
    taskKinds: ["diagram", "document", "image"],
  },
  "artifact-delete": {
    matches: everyIntentGroup(
      ["delete", "remove"],
      ["artifact", "deck", "diagram", "image", "pptx", "presentation"],
    ),
    taskKinds: ["diagram", "document", "image"],
  },
  "web-search": {
    matches: anyIntentPhrase(
      "current events",
      "current news",
      "current weather",
      "latest information",
      "latest news",
      "latest updates",
      "look up",
      "search the web",
      "web search",
    ),
    taskKinds: ["web"],
  },
  "page-read": {
    matches: anyIntentPhrase("article", "link", "page", "url", "website"),
    taskKinds: ["web"],
  },
  "research-report": {
    matches: anyIntentPhrase("investigate", "research", "sources"),
    taskKinds: ["research"],
  },
  "presentation-generation": {
    matches: everyIntentGroup(
      ["create", "draft", "generate", "make", "revise", "update"],
      ["deck", "presentation", "pptx", "slides"],
    ),
    taskKinds: ["document"],
  },
  "image-generation": {
    matches: everyIntentGroup(
      ["create", "draft", "generate", "make"],
      ["graphic", "image", "picture"],
    ),
    taskKinds: ["image"],
  },
  "diagram-generation": {
    matches: everyIntentGroup(
      ["create", "draft", "generate", "make"],
      ["chart", "diagram", "flowchart"],
    ),
    taskKinds: ["diagram"],
  },
  "skill-management": {
    matches: anyIntentPhrase("procedure", "skill"),
    taskKinds: ["skill"],
  },
  reminders: { matches: anyIntentPhrase("remind", "reminder"), taskKinds: ["reminder"] },
  workflows: {
    matches: anyIntentPhrase(
      "automate",
      "automation",
      "recurring",
      "research",
      "research report",
      "workflow",
    ),
    taskKinds: ["research", "workflow"],
  },
  gmail: {
    matches: matchesClosedIntent(
      /^(check|list|open|read|show|view) (my )?((latest|unread) )?(email|emails|gmail|gmail message|gmail messages|inbox)$/,
      /^(find|search) (my )?(email|emails|gmail|inbox)$/,
      /^send this exact gmail message now recipient .+ subject .+ body .+$/,
      /^schedule this exact gmail message recipient .+ subject .+ body .+ sendat .+$/,
    ),
    taskKinds: ["integration"],
  },
  "google-calendar": {
    matches: matchesClosedIntent(
      /^(check|list|open|read|show|view) (my )?(google )?calendar$/,
      /^what s on (my )?(google )?calendar$/,
    ),
    taskKinds: ["integration"],
  },
  "google-drive": {
    matches: matchesClosedIntent(
      /^(check|list|open|read|show|view) (my )?(google )?drive( file| files)?$/,
      /^download (a |the |my )?(google )?drive file$/,
    ),
    taskKinds: ["integration"],
  },
  "usage-management": {
    matches: anyIntentPhrase("billing", "plan", "subscription", "usage"),
    taskKinds: ["conversation"],
  },
} satisfies Record<CapabilityId, CapabilityIntentPolicy>;

/** Classify direct User language from the same closed policy used for capability relevance. */
export const taskKindsFor = (description: string): ReadonlyArray<TaskKind> => {
  const task = description.toLocaleLowerCase("en");
  const matchedKinds = closedCapabilityIds.flatMap((capabilityId) =>
    capabilityId !== "conversation" && capabilityIntentPolicy[capabilityId].matches(task)
      ? capabilityIntentPolicy[capabilityId].taskKinds
      : [],
  );
  return matchedKinds.length === 0 ? ["conversation"] : [...new Set(matchedKinds)];
};
