import { expect, test } from "vitest";
import { decodeEntities } from "../lib/confidential-input.ts";

test("an entity named constructor does not expand to Object", () => {
  expect(decodeEntities("a&constructor;")).toBe("a&constructor;");
});
