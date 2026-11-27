import { submodulePaths } from "./submodules.js";

export function eslintIgnorePatterns(root) {
  return [
    "node_modules/**",
    "coverage/**",
    "**/dist/**",
    "**/.astro/**",
    ".claude/**",
    ".githooks/**",
    ...submodulePaths(root).map((path) => `${path}/**`),
  ];
}
