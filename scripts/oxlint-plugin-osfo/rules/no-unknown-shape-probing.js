import { isApplicationSource, isIdentifier, isStringLiteral } from "../utils.js";

const isReflectGet = (node) =>
  node?.type === "MemberExpression" &&
  isIdentifier(node.object, "Reflect") &&
  isIdentifier(node.property, "get");

const isJsonParse = (node) =>
  node?.type === "MemberExpression" &&
  isIdentifier(node.object, "JSON") &&
  isIdentifier(node.property, "parse");

const isInlineShapeAssertion = (node) =>
  node?.type === "TSTypeLiteral" ||
  (node?.type === "TSTypeReference" && isIdentifier(node.typeName, "Record"));

export default {
  meta: {
    type: "problem",
    docs: { description: "Normalize unknown data at boundaries." },
  },
  create(context) {
    if (!isApplicationSource(context.filename)) return {};

    return {
      BinaryExpression(node) {
        if (node.operator !== "in" || !isStringLiteral(node.left)) return;
        context.report({
          node,
          message:
            "Decode unknown input with Effect Schema or a named typed adapter. Skill: wrdn-effect-schema-boundaries.",
        });
      },
      CallExpression(node) {
        if (!isReflectGet(node.callee) && !isJsonParse(node.callee)) return;
        context.report({
          node,
          message:
            "Decode unknown input with Effect Schema or a named typed adapter. Skill: wrdn-effect-schema-boundaries.",
        });
      },
      TSAsExpression(node) {
        const isDoubleCast =
          node.expression?.type === "TSAsExpression" &&
          node.expression.typeAnnotation?.type === "TSUnknownKeyword";
        if (!isDoubleCast && !isInlineShapeAssertion(node.typeAnnotation)) return;
        context.report({
          node,
          message:
            "Decode unknown input with Effect Schema or a named typed adapter instead of an inline shape assertion. Skill: wrdn-effect-schema-boundaries.",
        });
      },
    };
  },
};
