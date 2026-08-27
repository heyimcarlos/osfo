import { asSchema, type ModelMessage, type ToolSet, type UserModelMessage } from "ai";
import { Option, Predicate, Schema } from "effect";

import { Capabilities } from "../../services/capabilities";

/** Model input for one exact Skill identity from the current eligible index. */
export const LoadSkillToolInput = Schema.Struct({
  skillId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  skillVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});

/** Trusted facts projected from one Think turn without reading Tool or file content as intent. */
export interface TurnProjection {
  readonly taskDescription: string;
  readonly taskKinds: ReadonlyArray<Capabilities.TaskKind>;
  readonly trustedCapabilityIds: ReadonlyArray<Capabilities.CapabilityId>;
}

/** Project direct User task language without trusting historical Tool or file content. */
export const projectTurn = (
  messages: Array<ModelMessage>,
  trustedState: { readonly pendingFileAnalysis: boolean } = { pendingFileAnalysis: false },
): TurnProjection => {
  const taskDescription = currentTaskDescription(messages);
  const reconcilePendingAnalysis =
    trustedState.pendingFileAnalysis && isPendingAnalysisFollowUp(taskDescription);
  const trustedCapabilityIds = reconcilePendingAnalysis ? ["file-analysis" as const] : [];
  const directTaskKinds = Capabilities.taskKindsFor(taskDescription);
  return {
    taskDescription,
    taskKinds: [
      ...new Set([
        ...directTaskKinds.filter((kind) => !reconcilePendingAnalysis || kind !== "conversation"),
        ...(reconcilePendingAnalysis ? (["file"] as const) : []),
      ]),
    ],
    trustedCapabilityIds,
  };
};

/** Deterministically classify direct User language for catalog relevance. */
export const taskKindsFor = Capabilities.taskKindsFor;

export interface ToolProvenance {
  readonly source: "integration" | "native";
  readonly toolName: string;
}

export interface TrustedToolAssembly {
  readonly provenance: ReadonlyArray<ToolProvenance>;
  readonly rejectedReservedNames: ReadonlyArray<string>;
  readonly tools: ToolSet;
}

/** Restore only canonical native Tools and Think-compiled Actions at the model boundary. */
export const trustedToolAssembly = (input: {
  readonly actionNames: ReadonlyArray<Capabilities.RegisteredToolName>;
  readonly allTools: ToolSet;
  readonly integrationTools?: ToolSet;
  readonly nativeTools: ToolSet;
  readonly reservedNames: ReadonlyArray<Capabilities.RegisteredToolName>;
}): TrustedToolAssembly => {
  const reserved = new Set<string>(input.reservedNames);
  const trustedActions = input.actionNames.flatMap((toolName) => {
    const definition = input.allTools[toolName];
    return definition !== undefined && isThinkAction(definition)
      ? [[toolName, definition] as const]
      : [];
  });
  const trustedIntegrations = Object.entries(input.integrationTools ?? {}).filter(([toolName]) =>
    reserved.has(toolName),
  );
  const rejectedReservedNames = [...reserved].filter((toolName) => {
    const canonicalNative = input.nativeTools[toolName];
    const canonicalIntegration = input.integrationTools?.[toolName];
    const merged = input.allTools[toolName];
    return (
      (merged !== undefined && canonicalNative !== undefined && merged !== canonicalNative) ||
      (merged !== undefined &&
        canonicalIntegration !== undefined &&
        merged !== canonicalIntegration) ||
      (merged !== undefined &&
        input.actionNames.some((actionName) => actionName === toolName) &&
        !isThinkAction(merged))
    );
  });
  const trustedTools = {
    ...Object.fromEntries(trustedActions),
    ...Object.fromEntries(trustedIntegrations),
    ...input.nativeTools,
  } satisfies ToolSet;
  return {
    provenance: Object.keys(trustedTools).map((toolName) => ({
      source:
        input.integrationTools?.[toolName] === trustedTools[toolName] ? "integration" : "native",
      toolName,
    })),
    rejectedReservedNames,
    tools: trustedTools,
  };
};

/** Measure model Tool schemas at the Agent boundary before closed-registry selection. */
export const toolSchemaAccounting = (
  assembly: Pick<TrustedToolAssembly, "provenance" | "tools">,
): ReadonlyArray<{
  readonly bytes: number;
  readonly source: "integration" | "native";
  readonly toolName: string;
}> =>
  assembly.provenance.flatMap(({ source, toolName }) => {
    const definition = assembly.tools[toolName];
    if (definition === undefined) return [];
    if (!("inputSchema" in definition)) return [];
    const serialized = JSON.stringify({
      description: "description" in definition ? definition.description : undefined,
      inputSchema: asSchema(definition.inputSchema).jsonSchema,
    });
    return [{ bytes: new TextEncoder().encode(serialized).byteLength, source, toolName }];
  });

const isPendingAnalysisFollowUp = (taskDescription: string): boolean =>
  /^(check|did|has|is|was) (it |that |the (file )?analysis )?(done|finish|finished|ready|complete|completed|still running)( yet)?[?.!]*$/iu.test(
    taskDescription.trim(),
  );

const isThinkAction = (definition: ToolSet[string]): boolean =>
  "metadata" in definition &&
  Option.isSome(
    Schema.decodeUnknownOption(Schema.Struct({ cfThinkAction: Schema.Literal(true) }))(
      definition.metadata,
    ),
  );

const currentTaskDescription = (messages: Array<ModelMessage>): string => {
  const current = messages.reduceRight<UserModelMessage | undefined>(
    (found, candidate) => found ?? (candidate.role === "user" ? candidate : undefined),
    undefined,
  );
  if (current?.role !== "user") return "";
  if (Predicate.isString(current.content)) return current.content.trim();
  return current.content
    .filter((part) => part.type === "text")
    .map(({ text }) => text)
    .join("\n")
    .trim();
};

export * as CapabilityContext from "./capability-context";
