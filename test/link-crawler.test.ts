import { expect, test } from "vitest";
import {
  brokenLinkLines,
  extractHtmlUrls,
  fetchPageLinks,
  formatBrokenLink,
  isHtmlResponse,
  isInternalUrl,
  LinkCrawl,
  traceReferrers,
} from "../lib/link-crawler.ts";

const site = new URL("http://127.0.0.1:4321/");

test.each([
  ["http://127.0.0.1:4321/about", [], true],
  ["http://127.0.0.1:9999/about", [], false],
  ["blob:http://127.0.0.1:4321/id", [], false],
  ["http://127.0.0.1:4321/draft/post", ["/draft"], false],
  ["http://127.0.0.1:4321/docs/post", ["/draft"], true],
] as const)("isInternalUrl(%s, skips=%j) is %s", (href, skips, expected) => {
  expect(isInternalUrl(new URL(href), site, skips)).toBe(expected);
});

test.each([
  [{ "content-type": "text/html; charset=utf-8" }, true],
  [{ "content-type": "TEXT/HTML" }, true],
  [{ "content-type": "application/xhtml+xml" }, true],
  [{ "content-type": "application/json" }, false],
  [{}, false],
] as const)("isHtmlResponse handles headers %j", (headers, expected) => {
  expect(isHtmlResponse(new Response("", { headers }))).toBe(expected);
});

test.each([
  [
    '<base href="/first/"><base href="/second/"><a href="page">first base wins</a>',
    "http://127.0.0.1:4321/dir/index.html",
    ["http://127.0.0.1:4321/first/page"],
  ],
  [
    '<base href="http://[invalid"><a href="sibling">falls back to pageUrl</a>',
    "http://127.0.0.1:4321/dir/index.html",
    ["http://127.0.0.1:4321/dir/sibling"],
  ],
  [
    '<a href="">empty</a><a href="#top">hash</a><a href=" /ok?a=1&amp;b=2 ">trimmed</a>',
    "http://127.0.0.1:4321/",
    ["http://127.0.0.1:4321/ok?a=1&b=2"],
  ],
] as const)("extractHtmlUrls parses %s", async (body, pageUrl, expected) => {
  const response = new Response(body, { headers: { "content-type": "text/html" } });
  const urls = await extractHtmlUrls(response, pageUrl);
  expect(urls.map((url) => url.href)).toEqual(expected);
});

test.each([
  {
    label: "redirect with location",
    path: "/redir",
    handler: () => new Response(null, { status: 302, headers: { location: "/next" } }),
    expectedFor: (origin: string) => ({ status: 302, redirect: new URL("/next", origin) }),
  },
  {
    label: "redirect without location header",
    path: "/bare-redir",
    handler: () => new Response(null, { status: 302 }),
    expectedFor: () => ({ status: 302 }),
  },
  {
    label: "non-HTML 200 response",
    path: "/data.json",
    handler: () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
    expectedFor: () => ({ status: 200 }),
  },
  {
    label: "HTML 200 response",
    path: "/page",
    handler: () =>
      new Response('<a href="/child">child</a>', { headers: { "content-type": "text/html" } }),
    expectedFor: (origin: string) => ({ status: 200, links: [new URL("/child", origin)] }),
  },
])("fetchPageLinks handles $label", async ({ path, handler, expectedFor }) => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler,
  });
  try {
    const outcome = await fetchPageLinks(new URL(path, server.url).href);
    expect(outcome).toEqual(expectedFor(server.url.origin));
  } finally {
    await server.stop(true);
  }
});

test("fetchPageLinks returns an error outcome when fetch rejects", async () => {
  const outcome = await fetchPageLinks("http://127.0.0.1:0/unreachable");
  expect(Object.keys(outcome)).toEqual(["error"]);
  expect(typeof Object.values(outcome)[0]).toBe("string");
});

test.each([
  { label: "no referrers", path: "/missing", refEntries: [], redirectEntries: [], expected: [] },
  {
    label: "multi-hop redirect chain",
    path: "/dead",
    refEntries: [
      ["/dead", ["/hop2"]],
      ["/hop2", ["/hop1"]],
      ["/hop1", ["/"]],
    ] as const,
    redirectEntries: [
      ["/hop1", "/hop2"],
      ["/hop2", "/dead"],
    ] as const,
    expected: ["/hop2", "/hop1", "/"],
  },
  {
    label: "redirect cycle terminates",
    path: "/b",
    refEntries: [
      ["/b", ["/a"]],
      ["/a", ["/b"]],
    ] as const,
    redirectEntries: [
      ["/a", "/b"],
      ["/b", "/a"],
    ] as const,
    expected: ["/a", "/b"],
  },
  {
    label: "non-redirect referrer does not chain further",
    path: "/dead",
    refEntries: [
      ["/dead", ["/page"]],
      ["/page", ["/"]],
    ] as const,
    redirectEntries: [] as const,
    expected: ["/page"],
  },
])("traceReferrers handles $label", ({ path, refEntries, redirectEntries, expected }) => {
  const referrers = new Map(refEntries.map(([k, v]) => [k, new Set(v)]));
  const redirects = new Map(redirectEntries);
  expect(traceReferrers(path, referrers, redirects)).toEqual(expected);
});

test.each([
  { target: "/missing", result: 404, sources: [], expected: "  /missing (404) <- start URL" },
  {
    target: "/missing",
    result: 404,
    sources: ["/a", "/b"],
    expected: "  /missing (404) <- /a /b",
  },
  {
    target: "http://127.0.0.1/fail",
    result: "reset",
    sources: ["/"],
    expected: "  http://127.0.0.1/fail (reset) <- /",
  },
])("formatBrokenLink formats $target ($result)", ({ target, result, sources, expected }) => {
  expect(formatBrokenLink(target, result, sources)).toBe(expected);
});

test("brokenLinkLines skips healthy statuses and preserves status order", () => {
  const lines = brokenLinkLines("http://127.0.0.1:4321", {
    status: new Map<string, number | string>([
      ["/", 200],
      ["/moved", 302],
      ["/bad", 404],
      ["/err", "socket closed"],
    ]),
    referrers: new Map([
      ["/bad", new Set(["/"])],
      ["/err", new Set(["/moved"])],
    ]),
    redirects: new Map(),
    links: 2,
  });
  expect(lines).toEqual([
    "  /bad (404) <- /",
    "  http://127.0.0.1:4321/err (socket closed) <- /moved",
  ]);
});

test("LinkCrawl.enqueue deduplicates pathnames and keeps first query string", () => {
  const crawl = new LinkCrawl(site, ["/skip"]);
  expect(crawl.enqueue(new URL("http://127.0.0.1:4321/skip/page"), "/")).toBeUndefined();
  expect(crawl.enqueue(new URL("http://127.0.0.1:4321/item?a=1"), "/")).toBe("/item");
  expect(crawl.enqueue(new URL("http://127.0.0.1:4321/item?a=2"), "/other")).toBe("/item");
  expect(crawl.queue.get("/item")).toBe("http://127.0.0.1:4321/item?a=1");
  expect(crawl.referrers.get("/item")).toEqual(new Set(["/", "/other"]));
});

test("LinkCrawl.recordOutcome updates status, redirects, and internal link count", () => {
  const crawl = new LinkCrawl(site, []);
  crawl.recordOutcome("/err", { error: "boom" });
  crawl.recordOutcome("/go", { status: 302, redirect: new URL("http://127.0.0.1:4321/target") });
  crawl.recordOutcome("/page", {
    status: 200,
    links: [new URL("http://127.0.0.1:4321/a"), new URL("https://example.com/out")],
  });
  expect(crawl.status.get("/err")).toBe("boom");
  expect(crawl.redirects.get("/go")).toBe("/target");
  expect(crawl.links).toBe(1);
});
