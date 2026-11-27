import { submodulePaths } from "./submodules.js";

export const eslintToolIgnorePatterns = [".claude/**", ".githooks/**"];

export function eslintIgnorePatterns(root) {
  return [
    "node_modules/**",
    "coverage/**",
    "**/dist/**",
    "**/.astro/**",
    ...eslintToolIgnorePatterns,
    ...submodulePaths(root).map((path) => `${path}/**`),
  ];
}
