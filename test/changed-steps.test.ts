import { expect, test } from "vitest";
import { validGlob } from "../lib/changed-steps.ts";

test.each([[" ", false]])("classifies the fixed changed glob %j", (glob, accepted) => {
  expect(validGlob(glob)).toBe(accepted);
});
