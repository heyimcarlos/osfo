import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function unwrap(expression: ESTree.Expression): ESTree.Expression {
  if (
    expression.type === "ParenthesizedExpression" ||
    expression.type === "ChainExpression" ||
    expression.type === "TSAsExpression" ||
    expression.type === "TSSatisfiesExpression" ||
    expression.type === "TSTypeAssertion" ||
    expression.type === "TSNonNullExpression"
  ) {
    return unwrap(expression.expression);
  }
  return expression;
}

function staticPropertyName(expression: ESTree.Expression): string | null {
  const candidate = unwrap(expression);
  if (candidate.type !== "MemberExpression" || candidate.computed) return null;
  return candidate.property.type === "Identifier" ? candidate.property.name : null;
}

function isTransparentParent(parent: ESTree.Node, child: ESTree.Node): boolean {
  return (
    ((parent.type === "ParenthesizedExpression" ||
      parent.type === "ChainExpression" ||
      parent.type === "TSAsExpression" ||
      parent.type === "TSSatisfiesExpression" ||
      parent.type === "TSTypeAssertion" ||
      parent.type === "TSNonNullExpression") &&
      parent.expression === child) ||
    (parent.type === "MemberExpression" && parent.object === child)
  );
}

function isCalledThroughMemberAccess(node: ESTree.YieldExpression): boolean {
  let child: ESTree.Node = node;
  let parent: ESTree.Node | null = child.parent;
  while (parent !== null && isTransparentParent(parent, child)) {
    child = parent;
    parent = child.parent;
  }
  return parent?.type === "CallExpression" && parent.callee === child;
}

/** Require a named binding before invoking a Context.Service operation. */
const noNestedEffectServiceYield = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow method calls rooted in a nested Effect service yield; bind the service to a named variable first.",
    },
    messages: {
      nestedServiceYield:
        "Bind this service to a named variable before calling its method, for example `const service = yield* Domain.Service`.",
    },
  },
  create(context) {
    return {
      YieldExpression(node) {
        if (
          !node.delegate ||
          node.argument === null ||
          staticPropertyName(node.argument) !== "Service" ||
          !isCalledThroughMemberAccess(node)
        ) {
          return;
        }
        context.report({ node, messageId: "nestedServiceYield" });
      },
    };
  },
});

export default noNestedEffectServiceYield;
