import { expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { inputTestRepo, runInputCheck } from "./preloaded-check.ts";
import { testDirectory } from "./test-directory.ts";

test("check-coupling propagates unexpected package-text parser failures", () => {
  using fixture = testDirectory();
  inputTestRepo(fixture.folder);
  const value = '{"name":"input-fixture"}';
  writeFileSync(join(fixture.folder, "package.json"), value);
  const run = runInputCheck(
    fixture.folder,
    ["check-coupling"],
    `
const parse = JSON.parse;
let examined = 0;
JSON.parse = (text, reviver) => {
  if (text === ${JSON.stringify(value)} && ++examined === 3)
    throw new Error("package text parsing failed");
  return parse(text, reviver);
};
`,
  );
  expect(run().stderr).toMatch(/^error: package text parsing failed$/m);
});
