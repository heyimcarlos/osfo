import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";

import { repoRoot } from "../utils.js";

const packageRoots = [];

for (const parent of ["apps", "packages"]) {
  const directory = join(repoRoot, parent);
  if (!existsSync(directory)) continue;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(directory, entry.name);
    const packageJson = join(root, "package.json");
    if (!existsSync(packageJson)) continue;
    const manifest = JSON.parse(readFileSync(packageJson, "utf8"));
    if (typeof manifest.name === "string") packageRoots.push({ root, name: manifest.name });
  }
}

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
    return {
      ImportDeclaration(node) {
        const specifier = node.source.value;
        if (typeof specifier !== "string" || !specifier.startsWith(".")) return;
        const sourcePackage = findPackage(resolve(context.filename));
        const targetPackage = findPackage(resolve(dirname(context.filename), specifier));
        if (!sourcePackage || !targetPackage || sourcePackage.root === targetPackage.root) return;
        context.report({
          node: node.source,
          message: `Import ${targetPackage.name} through its public package export. Skill: wrdn-package-boundaries.`,
        });
      },
    };
  },
};
