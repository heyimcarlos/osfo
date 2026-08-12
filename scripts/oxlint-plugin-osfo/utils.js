import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const toRepoRelative = (filename) =>
  relative(repoRoot, resolve(filename)).split(sep).join("/");

export const isTestLike = (filename) => {
  const path = toRepoRelative(filename);
  return /(?:^|\/)(?:test\/.*|.*\.(?:test|spec)\.tsx?)$/u.test(path);
};

export const isApplicationSource = (filename) =>
  !isTestLike(filename) &&
  /^(?:apps|packages)\/[^/]+\/src\/.*\.[cm]?[jt]sx?$/u.test(toRepoRelative(filename));

export const getPropertyName = (node) => {
  if (node?.type === "Identifier" || node?.type === "PrivateIdentifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
};

export const unwrapExpression = (node) => {
  let current = node;
  while (
    current?.type === "ChainExpression" ||
    current?.type === "ParenthesizedExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
};

export const isIdentifier = (node, name) =>
  node?.type === "Identifier" && (name === undefined || node.name === name);

export const isStringLiteral = (node) => node?.type === "Literal" && typeof node.value === "string";
