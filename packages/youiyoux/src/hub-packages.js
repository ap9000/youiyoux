// The bundle's stand-in for apps/web/scripts/packages.ts: the tool's packages, bundled.
const PACKAGES = {
  core: () => import("../../core/src/index.ts"),
  scanner: () => import("../../scanner/src/index.ts"),
  discover: () => import("../../discover/src/index.ts"),
  tokens: () => import("../../tokens/src/index.ts"),
};

export const loadPackage = (name) => PACKAGES[name]();
