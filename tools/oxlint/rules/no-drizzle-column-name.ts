import { defineRule, type ESTree } from "@oxlint/plugins";

import { toRepositoryPath } from "../shared/repository.ts";

const columnBuilders = new Set([
  "agentId",
  "allowancePeriodId",
  "assistantMessageId",
  "bigint",
  "blob",
  "boolean",
  "fileAnalysisId",
  "fileAnalysisState",
  "fileDigest",
  "fileId",
  "fileMediaType",
  "fileName",
  "fileState",
  "fileUploadId",
  "initializationId",
  "integer",
  "json",
  "jsonb",
  "numeric",
  "modelCallAttemptId",
  "real",
  "routeId",
  "serial",
  "sessionId",
  "text",
  "timestamp",
  "thinkRequestId",
  "userId",
  "uuid",
  "varchar",
]);

function isOwnedSchema(filename: string): boolean {
  const path = toRepositoryPath(filename);
  return (
    path === "apps/worker/src/agents/osfo/db/schema.ts" ||
    (/^packages\/db\/src\/schema\/[^/]+\.ts$/u.test(path) &&
      path !== "packages/db/src/schema/auth.ts" &&
      path !== "packages/db/src/schema/index.ts")
  );
}

function builderName(callee: ESTree.Expression | ESTree.Super): string | undefined {
  return callee.type === "Identifier" ? callee.name : undefined;
}

/** Keep TypeScript and SQL column identities equal in Osfo-owned Drizzle schemas. */
const noDrizzleColumnName = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicit Drizzle column names in Osfo-owned schemas; use snake_case object keys.",
    },
    messages: {
      explicitColumn:
        "Use the SQL snake_case name as the object key and let Drizzle infer the column name.",
    },
  },
  create(context) {
    if (!isOwnedSchema(context.filename)) return {};

    return {
      CallExpression(node) {
        const name = builderName(node.callee);
        if (name === undefined || !columnBuilders.has(name)) return;
        const columnName = node.arguments[0];
        if (
          columnName === undefined ||
          columnName.type !== "Literal" ||
          columnName.raw === null ||
          (!columnName.raw.startsWith('"') && !columnName.raw.startsWith("'"))
        ) {
          return;
        }
        context.report({ node: columnName, messageId: "explicitColumn" });
      },
    };
  },
});

export default noDrizzleColumnName;
