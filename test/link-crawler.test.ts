import { createServer } from "node:net";
import { expect, test } from "vitest";
import {
  brokenLinkLines,
  extractHtmlUrls,
  formatBrokenLink,
  isHtmlResponse,
  isInternalUrl,
  LinkCrawl,
  traceReferrers,
} from "../lib/link-crawler.ts";

const site = new URL("http://127.0.0.1:4321/");

function listeningPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("server not bound");
  return address.port;
}

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
  const urls: string[] = [];
  await extractHtmlUrls(response, pageUrl, (url) => urls.push(url.href));
  expect(urls).toEqual(expected);
});

test.each([
  {
    label: "redirect with location",
    path: "/redir",
    handler: () => new Response(null, { status: 302, headers: { location: "/next" } }),
    expectedStatus: 302,
    expectedRedirect: "/next",
    expectedQueued: true,
    expectedLinks: 0,
  },
  {
    label: "redirect without location header",
    path: "/bare-redir",
    handler: () => new Response(null, { status: 302 }),
    expectedStatus: 302,
    expectedRedirect: undefined,
    expectedQueued: false,
    expectedLinks: 0,
  },
  {
    label: "non-HTML 200 response",
    path: "/data.json",
    handler: () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
    expectedStatus: 200,
    expectedRedirect: undefined,
    expectedQueued: false,
    expectedLinks: 0,
  },
  {
    label: "HTML 200 response",
    path: "/page",
    handler: () =>
      new Response('<a href="/child">child</a><a href="https://example.com/out">out</a>', {
        headers: { "content-type": "text/html" },
      }),
    expectedStatus: 200,
    expectedRedirect: undefined,
    expectedQueued: true,
    expectedLinks: 1,
  },
])(
  "LinkCrawl.visitPage handles $label",
  async ({ path, handler, expectedStatus, expectedRedirect, expectedQueued, expectedLinks }) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    try {
      const crawl = new LinkCrawl(new URL("/", server.url), []);
      await crawl.visitPage(path, new URL(path, server.url).href);
      expect(crawl.status.get(path)).toBe(expectedStatus);
      expect(crawl.redirects.get(path)).toBe(expectedRedirect);
      expect(crawl.queue.size > 1).toBe(expectedQueued);
      expect(crawl.links).toBe(expectedLinks);
    } finally {
      await server.stop(true);
    }
  },
);

test("LinkCrawl.visitPage records an error status when fetch rejects", async () => {
  const crawl = new LinkCrawl(site, []);
  await crawl.visitPage("/unreachable", "http://127.0.0.1:0/unreachable");
  expect(typeof crawl.status.get("/unreachable")).toBe("string");
});

test("LinkCrawl.visitPage keeps links streamed before a mid-body socket reset", async () => {
  const chunk = '<a href="/x">x</a>';
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.write(
        "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/html\r\n" +
          "Transfer-Encoding: chunked\r\n\r\n" +
          `${chunk.length.toString(16)}\r\n${chunk}\r\n`,
        () => {
          setTimeout(() => socket.destroy(), 20);
        },
      );
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const port = listeningPort(server);
  try {
    const base = new URL(`http://127.0.0.1:${port}/`);
    const crawl = new LinkCrawl(base, []);
    await crawl.visitPage("/", base.href);
    expect(typeof crawl.status.get("/")).toBe("string");
    expect(crawl.queue.has("/x")).toBe(true);
    expect(crawl.links).toBe(1);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
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
