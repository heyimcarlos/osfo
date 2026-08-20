import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function isEffectDie(expression: ESTree.Expression): boolean {
  if (expression.type !== "MemberExpression" || expression.computed) return false;
  return (
    expression.object.type === "Identifier" &&
    expression.object.name === "Effect" &&
    expression.property.type === "Identifier" &&
    expression.property.name === "die"
  );
}

function isStringLiteral(expression: ESTree.Expression): boolean {
  if (expression.type !== "Literal" || expression.raw === null) return false;
  return expression.raw.startsWith('"') || expression.raw.startsWith("'");
}

/** Preserve defect messages and stacks by requiring Error values. */
const noEffectDieString = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow string and template literal arguments to Effect.die.",
    },
    messages: {
      stringDefect: "Pass an `Error` value to `Effect.die`, not a string or template literal.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        if (!isEffectDie(node.callee)) return;
        const defect = node.arguments[0];
        if (
          defect === undefined ||
          defect.type === "SpreadElement" ||
          (defect.type !== "TemplateLiteral" && !isStringLiteral(defect))
        ) {
          return;
        }
        context.report({ node: defect, messageId: "stringDefect" });
      },
    };
  },
});

export default noEffectDieString;
