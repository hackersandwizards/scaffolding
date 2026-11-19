import { expect, test } from "vitest";
import { rejection } from "../lib/rejection.ts";

test("rejection gives the error's text", async () => {
  expect(await rejection(Promise.reject(new Error("no answer")))).toBe("Error: no answer");
});

test("rejection reports what resolved when a promise does not reject", async () => {
  expect(await rejection(rejection(Promise.resolve({ a: 1 })))).toBe(
    'Error: expected a rejection, resolved with {"a":1}',
  );
  expect(await rejection(rejection(Promise.resolve(1n)))).toBe(
    "Error: expected a rejection, resolved with 1",
  );
});

test("rejection shortens a long value and names the site of the call in the trace", async () => {
  const failure = await rejection(Promise.resolve("x".repeat(5000))).catch((e: Error) => e);
  expect((failure as Error).message).toBe(
    `expected a rejection, resolved with "${"x".repeat(199)}… (5002 characters)`,
  );
  expect((failure as Error).stack).toContain("rejection.test.ts");
});
