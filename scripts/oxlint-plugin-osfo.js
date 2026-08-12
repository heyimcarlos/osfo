import noCrossPackageRelativeImports from "./oxlint-plugin-osfo/rules/no-cross-package-relative-imports.js";
import noRawFetch from "./oxlint-plugin-osfo/rules/no-raw-fetch.js";

export default {
  meta: { name: "osfo", version: "1.0.0" },
  rules: {
    "no-cross-package-relative-imports": noCrossPackageRelativeImports,
    "no-raw-fetch": noRawFetch,
  },
};
