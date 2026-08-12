import noCrossPackageRelativeImports from "./oxlint-plugin-osfo/rules/no-cross-package-relative-imports.js";
import noRawFetch from "./oxlint-plugin-osfo/rules/no-raw-fetch.js";
import noUnknownShapeProbing from "./oxlint-plugin-osfo/rules/no-unknown-shape-probing.js";
import noUntypedEffectErrors from "./oxlint-plugin-osfo/rules/no-untyped-effect-errors.js";

export default {
  meta: { name: "osfo", version: "1.0.0" },
  rules: {
    "no-cross-package-relative-imports": noCrossPackageRelativeImports,
    "no-raw-fetch": noRawFetch,
    "no-unknown-shape-probing": noUnknownShapeProbing,
    "no-untyped-effect-errors": noUntypedEffectErrors,
  },
};
