import { defineRule } from "@oxlint/plugins";

/** Require named imports, including named imports of canonical namespace exports. */
const noStarImport = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow namespace imports; import a module's canonical namespace export by name.",
    },
    messages: {
      starImport:
        "Replace this namespace import with named imports. If the module self-exports a canonical namespace, import that namespace by name.",
    },
  },
  create(context) {
    return {
      ImportNamespaceSpecifier(node) {
        context.report({ node, messageId: "starImport" });
      },
    };
  },
});

export default noStarImport;
