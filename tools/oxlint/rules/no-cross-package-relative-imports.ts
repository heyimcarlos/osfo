import { defineRule, type ESTree } from "@oxlint/plugins";
import { Schema } from "effect";

import { findPackage, resolveImport } from "../shared/repository.ts";

const isString = Schema.is(Schema.String);

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Preserve workspace package exports." },
    messages: {
      crossPackageImport:
        "Import {{packageName}} through its public package export. Skill: wrdn-package-boundaries.",
    },
  },
  create(context) {
    const inspectModuleSource = (source: ESTree.Expression | null) => {
      if (source?.type !== "Literal" || !isString(source.value) || !source.value.startsWith(".")) {
        return;
      }

      const sourcePackage = findPackage(context.filename);
      const targetPackage = findPackage(resolveImport(context.filename, source.value));
      if (
        sourcePackage === undefined ||
        targetPackage === undefined ||
        sourcePackage.path === targetPackage.path
      ) {
        return;
      }

      context.report({
        node: source,
        messageId: "crossPackageImport",
        data: { packageName: targetPackage.name },
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
});
