import { defineRule, type ESTree } from "@oxlint/plugins";

import { isIdentifier, propertyName, unwrapExpression } from "../shared/ast.ts";
import { toRepositoryPath } from "../shared/repository.ts";

const globalObjects = new Set(["globalThis", "self", "window"]);

function isTestLike(filename: string): boolean {
  return /(?:^|\/)(?:test\/.*|.*\.(?:test|spec)\.tsx?)$/u.test(toRepositoryPath(filename));
}

function isApplicationSource(filename: string): boolean {
  const path = toRepositoryPath(filename);
  return (
    !filename.endsWith(".d.ts") &&
    !isTestLike(filename) &&
    /^(?:apps|packages)\/[^/]+\/src\/.*\.[cm]?[jt]sx?$/u.test(path)
  );
}

function isGlobalFetchMember(expression: ESTree.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type !== "MemberExpression") return false;

  const object = unwrapExpression(unwrapped.object);
  return (
    object.type === "Identifier" &&
    globalObjects.has(object.name) &&
    propertyName(unwrapped.property) === "fetch"
  );
}

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Route application HTTP through Effect boundaries." },
    messages: {
      rawFetch:
        "Route HTTP through Effect HttpClient or an explicit host adapter. Skill: wrdn-effect-raw-fetch-boundary.",
    },
  },
  create(context) {
    if (!isApplicationSource(context.filename)) return {};

    return {
      CallExpression(node) {
        if (!isIdentifier(node.callee, "fetch") && !isGlobalFetchMember(node.callee)) return;
        context.report({ node: node.callee, messageId: "rawFetch" });
      },
      MemberExpression(node) {
        if (node.parent?.type === "CallExpression" && node.parent.callee === node) return;
        if (!isGlobalFetchMember(node)) return;
        context.report({ node, messageId: "rawFetch" });
      },
    };
  },
});
