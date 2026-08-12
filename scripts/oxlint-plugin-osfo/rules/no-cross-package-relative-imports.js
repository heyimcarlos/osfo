import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";

import { repoRoot } from "../utils.js";

const workspaceManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const workspacePatterns = Array.isArray(workspaceManifest.workspaces)
  ? workspaceManifest.workspaces
  : [];
const workspaceRoots = workspacePatterns.flatMap((pattern) => {
  if (typeof pattern !== "string") return [];
  if (!pattern.endsWith("/*")) return [join(repoRoot, pattern)];
  const parent = join(repoRoot, pattern.slice(0, -2));
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));
});

const packageRoots = workspaceRoots.flatMap((root) => {
  const packageJson = join(root, "package.json");
  if (!existsSync(packageJson)) return [];
  const manifest = JSON.parse(readFileSync(packageJson, "utf8"));
  return typeof manifest.name === "string" ? [{ root, name: manifest.name }] : [];
});

const findPackage = (path) => {
  const normalized = normalize(path);
  return packageRoots.find(
    (candidate) =>
      normalized === candidate.root || normalized.startsWith(`${candidate.root}${sep}`),
  );
};

export default {
  meta: { type: "problem", docs: { description: "Preserve workspace package exports." } },
  create(context) {
    const inspectModuleSource = (source) => {
      const specifier = source?.value;
      if (typeof specifier !== "string" || !specifier.startsWith(".")) return;
      const sourcePackage = findPackage(resolve(context.filename));
      const targetPackage = findPackage(resolve(dirname(context.filename), specifier));
      if (!sourcePackage || !targetPackage || sourcePackage.root === targetPackage.root) return;
      context.report({
        node: source,
        message: `Import ${targetPackage.name} through its public package export. Skill: wrdn-package-boundaries.`,
      });
    };
    return {
      ImportDeclaration(node) {
        inspectModuleSource(node.source);
      },
      ExportNamedDeclaration(node) {
        inspectModuleSource(node.source);
      },
      ExportAllDeclaration(node) {
        inspectModuleSource(node.source);
      },
      ImportExpression(node) {
        inspectModuleSource(node.source);
      },
    };
  },
};
