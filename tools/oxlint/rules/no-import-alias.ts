import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function importedName(node: ESTree.ImportSpecifier): string {
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

/** Keep value imports canonical; permit type aliases only in dedicated type imports. */
const noImportAlias = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow aliased value imports and inline aliased type imports; dedicated type imports may resolve real type-name collisions.",
    },
    messages: {
      importAlias:
        "Import `{{imported}}` with its canonical name. Put an unavoidable type-name collision in a dedicated `import type` declaration.",
    },
  },
  create(context) {
    return {
      ImportSpecifier(node) {
        const imported = importedName(node);
        if (imported === node.local.name) return;
        if (node.parent.type === "ImportDeclaration" && node.parent.importKind === "type") return;
        context.report({
          node,
          messageId: "importAlias",
          data: { imported },
        });
      },
    };
  },
});

export default noImportAlias;
