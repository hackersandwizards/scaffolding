import { mock } from "bun:test";
import { shellcheckScratch } from "../lib/shellcheck.ts";

const fixture = process.env.SCAFFOLDING_TEST_SHELLCHECK;
if (fixture) {
  await mock.module("../lib/shellcheck.ts", () => ({
    shellcheckBinary: () => Promise.resolve(fixture),
    shellcheckScratch,
  }));
}

const response = process.env.SCAFFOLDING_TEST_SHELLCHECK_RESPONSE;
if (response)
  globalThis.fetch = Object.assign(
    (url: RequestInfo | URL, options?: RequestInit) => {
      if (
        !String(url).startsWith(
          "https://github.com/koalaman/shellcheck/releases/download/v0.11.0/",
        ) ||
        options?.credentials !== "omit" ||
        options.headers
      ) {
        throw new Error("unexpected ShellCheck request");
      }
      return Promise.resolve(
        response === "unavailable"
          ? new Response(null, { status: 503 })
          : new Response("incorrect archive"),
      );
    },
    { preconnect: globalThis.fetch.preconnect },
  );
