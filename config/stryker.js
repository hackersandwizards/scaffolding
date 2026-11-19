export default {
  testRunner: "vitest",
  vitest: { related: false },
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: ".stryker-reports/mutation.json" },
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
  ignorePatterns: [".*"],
  ignoreStatic: true,
  incremental: true,
  incrementalFile: ".stryker-reports/incremental.json",
  concurrency: 2,
};
