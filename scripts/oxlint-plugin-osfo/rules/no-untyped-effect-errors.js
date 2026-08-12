import { getPropertyName, isApplicationSource, isIdentifier, unwrapExpression } from "../utils.js";

const effectEscapeHatches = new Set(["die", "dieMessage", "orDie", "orDieWith"]);

const memberCall = (node, objectName, properties) => {
  const callee = unwrapExpression(node.callee);
  if (callee?.type !== "MemberExpression") return false;
  return (
    isIdentifier(unwrapExpression(callee.object), objectName) &&
    properties.has(getPropertyName(callee.property))
  );
};

const promiseCatch = (node) => {
  const callee = unwrapExpression(node.callee);
  return (
    callee?.type === "MemberExpression" &&
    getPropertyName(callee.property) === "catch" &&
    !isIdentifier(unwrapExpression(callee.object), "Effect")
  );
};

const unknownErrorName = (node) =>
  node?.type === "Identifier" && /^(?:cause|error|reason)$/u.test(node.name);

export default {
  meta: { type: "problem", docs: { description: "Keep failures in the typed Effect channel." } },
  create(context) {
    if (!isApplicationSource(context.filename)) return {};

    return {
      BinaryExpression(node) {
        if (node.operator !== "instanceof" || !isIdentifier(node.right, "Error")) return;
        context.report({
          node,
          message:
            "Do not branch on untyped global Error values in Effect source. Skill: wrdn-effect-typed-errors.",
        });
      },
      CallExpression(node) {
        if (memberCall(node, "Promise", new Set(["reject"]))) {
          context.report({
            node,
            message:
              "Use Effect.fail or Effect.tryPromise with a tagged error. Skill: wrdn-effect-typed-errors.",
          });
        }
        if (promiseCatch(node)) {
          context.report({
            node,
            message:
              "Keep Promise failures in an Effect typed error channel. Skill: wrdn-effect-typed-errors.",
          });
        }
        if (
          isIdentifier(unwrapExpression(node.callee), "String") &&
          unknownErrorName(node.arguments[0])
        ) {
          context.report({
            node,
            message:
              "Normalize unknown failure values into a tagged error instead of stringifying them. Skill: wrdn-effect-typed-errors.",
          });
        }
      },
      MemberExpression(node) {
        if (
          getPropertyName(node.property) === "message" &&
          unknownErrorName(unwrapExpression(node.object))
        ) {
          context.report({
            node,
            message:
              "Normalize unknown failure values before reading a message. Skill: wrdn-effect-typed-errors.",
          });
          return;
        }
        if (!isIdentifier(unwrapExpression(node.object), "Effect")) return;
        if (!effectEscapeHatches.has(getPropertyName(node.property))) return;
        context.report({
          node,
          message:
            "Keep failures typed instead of converting them to defects. Skill: wrdn-effect-typed-errors.",
        });
      },
      NewExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "Error") return;
        context.report({
          node,
          message:
            "Use an existing tagged domain error in the Effect error channel. Skill: wrdn-effect-typed-errors.",
        });
      },
      ThrowStatement(node) {
        context.report({
          node,
          message:
            "Model application failure with a tagged error in the Effect error channel. Skill: wrdn-effect-typed-errors.",
        });
      },
      TryStatement(node) {
        context.report({
          node,
          message:
            "Use Effect failure handling in application source. Keep try/catch only in a documented adapter override. Skill: wrdn-effect-typed-errors.",
        });
      },
    };
  },
};
