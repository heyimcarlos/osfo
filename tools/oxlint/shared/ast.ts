import type { ESTree } from "@oxlint/plugins";
import { Schema } from "effect";

const isString = Schema.is(Schema.String);

export function stringLiteralValue(
  node: ESTree.Expression | ESTree.PrivateIdentifier,
): string | undefined {
  if (node.type === "Literal" && isString(node.value)) return node.value;
  return undefined;
}

export function propertyName(
  node: ESTree.Expression | ESTree.PrivateIdentifier,
): string | undefined {
  if (node.type === "Identifier" || node.type === "PrivateIdentifier") return node.name;
  return stringLiteralValue(node);
}

export function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (
    current.type === "ChainExpression" ||
    current.type === "ParenthesizedExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
}

export function isIdentifier(expression: ESTree.Expression, name: string): boolean {
  const unwrapped = unwrapExpression(expression);
  return unwrapped.type === "Identifier" && unwrapped.name === name;
}
