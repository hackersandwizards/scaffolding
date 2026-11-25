import { expect, test } from "vitest";
import { rejection } from "../lib/rejection.ts";

test("rejection gives the error's text", async () => {
  expect(await rejection(Promise.reject(new Error("no answer")))).toBe("Error: no answer");
});

test("rejection can describe a resolved BigInt", async () => {
  expect(await rejection(rejection(Promise.resolve(1n)))).toBe(
    "Error: expected a rejection, resolved with 1",
  );
});

test("rejection gives the resolved value as text when its serializer throws", async () => {
  const value = {
    toJSON() {
      throw new TypeError("broken serializer");
    },
  };
  expect(await rejection(rejection(Promise.resolve(value)))).toBe(
    "Error: expected a rejection, resolved with [object Object]",
  );
});

test("rejection can describe a resolved undefined", async () => {
  expect(await rejection(rejection(Promise.resolve(undefined)))).toBe(
    "Error: expected a rejection, resolved with undefined",
  );
});

test("rejection names the call site in the trace", async () => {
  const failure = await rejection(Promise.resolve("x")).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).stack).toContain("rejection.test.ts");
});
