import { getPropertyName, isApplicationSource, isIdentifier, unwrapExpression } from "../utils.js";

const isGlobalFetchMember = (node) => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "MemberExpression") return false;
  const object = unwrapExpression(expression.object);
  return (
    getPropertyName(expression.property) === "fetch" &&
    (isIdentifier(object, "globalThis") ||
      isIdentifier(object, "window") ||
      isIdentifier(object, "self"))
  );
};

export default {
  meta: { type: "problem", docs: { description: "Route HTTP through Effect boundaries." } },
  create(context) {
    if (!isApplicationSource(context.filename)) return {};

    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (!isIdentifier(callee, "fetch") && !isGlobalFetchMember(callee)) return;
        context.report({
          node: node.callee,
          message:
            "Route HTTP through Effect HttpClient or an explicit host adapter. Skill: wrdn-effect-raw-fetch-boundary.",
        });
      },
      MemberExpression(node) {
        if (node.parent?.type === "CallExpression" && node.parent.callee === node) return;
        if (!isGlobalFetchMember(node)) return;
        context.report({
          node,
          message:
            "Route HTTP through Effect HttpClient or an explicit host adapter. Skill: wrdn-effect-raw-fetch-boundary.",
        });
      },
    };
  },
};
