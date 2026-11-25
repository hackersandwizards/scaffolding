import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { assert, expect, test } from "vitest";

function runSiteCommand(name: string, args: string[], preload?: string, load = "0") {
  const bin = join(import.meta.dirname, "..", "bin", `${name}.ts`);
  const entry = preload
    ? [
        "-e",
        `${preload}\nprocess.argv = [process.execPath, ...${JSON.stringify([bin, ...args])}]; await import(${JSON.stringify(bin)});`,
      ]
    : [bin, ...args];
  const child = Bun.spawn([process.execPath, "--no-env-file", ...entry], {
    env: { ...process.env, SCAFFOLDING_LOAD: load },
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
}

function bunServer(code: string): string {
  return `${JSON.stringify(process.execPath)} --no-env-file -e '${code}'; :`;
}

const serverCommand = bunServer(
  'console.error("server stderr"); Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => new Response(String(process.pid)) });',
);

test.each([
  { code: 0, flags: ["--timeout", "120"], output: "" },
  { code: 37, flags: ["--stderr"], output: "server stderr\n" },
])(
  "with-server substitutes every URL, returns status $code and stops the server",
  async ({ code, flags, output }) => {
    const check = `
    const [url, repeated] = process.argv.slice(1);
      console.log(url);
      console.log(repeated);
      console.log(await (await fetch(url)).text());
    process.exit(${code});
  `;
    const [status, stdout, stderr] = await runSiteCommand("with-server", [
      ...flags,
      serverCommand,
      "--",
      process.execPath,
      "-e",
      check,
      "--",
      "{url}",
      "a={url}&b={url}",
    ]);
    expect(status, stderr).toBe(code);
    expect(stderr).toBe(output);
    const [url, repeated, serverPid] = stdout.trimEnd().split("\n");
    const pid = Number(serverPid);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(repeated).toBe(`a=${url}&b=${url}`);
    expect(pid).toBeGreaterThan(0);
    const alive = () => {
      try {
        return process.kill(pid, 0);
      } catch {
        return false;
      }
    };
    await expect.poll(alive).toBe(false);
  },
);

test("with-server fails when the server never answers within the readiness timeout", async () => {
  const [status, stdout, stderr] = await runSiteCommand("with-server", [
    "--timeout",
    "0.1",
    bunServer(
      'await Bun.sleep(1500); Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => new Response("ready") });',
    ),
    "--",
    process.execPath,
    "-e",
    'console.log("check ran")',
  ]);
  expect(status).toBe(1);
  expect(stderr).toContain("no answer");
  expect(stdout).toBe("");
});

const slowServer = bunServer(`
      process.on("SIGTERM", () => {});
      setTimeout(() => process.exit(0), 4500);
      Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => new Response(String(process.pid)) });
`);
test.each([
  ["inherited", slowServer],
  ["redirected", `{ ${slowServer}; } 2>/dev/null`],
])("with-server kills a server that ignores SIGTERM with %s stderr", async (_, command) => {
  const started = performance.now();
  const [status, stdout, stderr] = await runSiteCommand("with-server", [
    command,
    "--",
    process.execPath,
    "-e",
    "console.log(await (await fetch(process.argv[1])).text());",
    "--",
    "{url}",
  ]);
  expect(status, stderr).toBe(0);
  expect(performance.now() - started).toBeLessThan(3200);
  const pid = Number(stdout.trim());
  expect(pid).toBeGreaterThan(0);
  await expect
    .poll(() => {
      try {
        return process.kill(pid, 0);
      } catch {
        return false;
      }
    })
    .toBe(false);
});

test("with-server returns 1 when the check dies on a signal", async () => {
  const [status, stdout, stderr] = await runSiteCommand("with-server", [
    serverCommand,
    "--",
    process.execPath,
    "-e",
    'console.log("check started"); process.kill(process.pid, "SIGKILL");',
  ]);
  expect(status, stderr).toBe(1);
  expect(stdout).toBe("check started\n");
});

test.each([
  ["0", 120],
  ["99999", 1200],
])("with-server uses the default wall limit scaled for load %s", async (load, seconds) => {
  const [status, , stderr] = await runSiteCommand(
    "with-server",
    [serverCommand, "--", process.execPath, "-e", "await Bun.sleep(1000);"],
    `const original = setTimeout;
     globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 120_000 || ms === 1_200_000 ? 50 : ms, ...args);`,
    load,
  );
  expect(status, stderr).toBe(124);
  expect(stderr).toContain(`check reached the ${seconds}-second wall limit`);
  expect(stderr).toContain("--limit");
});

test.each([
  [
    "0.05",
    124,
    "",
    expect.stringMatching(/check reached the 0\.05-second wall limit[^\n]*--limit/),
  ],
  ["3", 0, "check finished\n", ""],
] as const)(
  "with-server runs the same check with --limit %s",
  async (limit, expected, output, error) => {
    const [status, stdout, stderr] = await runSiteCommand("with-server", [
      "--limit",
      limit,
      serverCommand,
      "--",
      process.execPath,
      "-e",
      'await Bun.sleep(300); console.log("check finished");',
    ]);
    expect(status, stderr).toBe(expected);
    expect(stdout).toBe(output);
    expect(stderr).toEqual(error);
  },
);

test.each([
  ["with-server", ["echo server", "echo check"], "usage: with-server"],
  ["with-server", ["--timeout", "0", "echo server", "--", "echo"], "usage: with-server"],
  [
    "with-server",
    ["--limit", "0", "echo server", "--", "echo"],
    "--limit must be a positive number",
  ],
  ["check-links", ["file:///index.html"], "usage: check-links"],
  ["check-links", ["http://127.0.0.1:0/sub/"], "usage: check-links"],
  ["check-links", ["http://127.0.0.1", "--concurrency", "0"], "usage: check-links"],
] as const)("%s rejects invalid usage with status 2", async (name, args, diagnostic) => {
  const [status, , stderr] = await runSiteCommand(name, [...args]);
  expect(status).toBe(2);
  expect(stderr).toContain(`usage: ${name}`);
  expect(stderr).toContain(diagnostic);
});

function html(body: string) {
  return new Response(body, { headers: { "content-type": "text/html" } });
}

async function crawlFixture(
  routes: Record<string, (url: URL) => Response | Promise<Response>>,
  args: string[] = [],
  missingStatus = 404,
) {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const target = url.pathname + url.search;
      requests.push(target);
      const reply = routes[target] ?? routes[url.pathname];
      return reply?.(url) ?? new Response(null, { status: missingStatus });
    },
  });
  try {
    const [status, stdout, stderr] = await runSiteCommand("check-links", [
      server.url.href,
      ...args,
    ]);
    return { status, stdout, stderr, requests };
  } finally {
    await server.stop(true);
  }
}

test("check-links reports broken targets with the pages carrying their links, including redirects", async () => {
  const result = await crawlFixture(
    {
      "/": () => html('<a href="/sub/page">subpage</a><a href="/sub/dead">dead</a>'),
      "/sub/page": () => html(`<a href='dead'>dead</a><a href=/redirect>redirect</a>`),
      "/redirect": () =>
        new Response(null, {
          status: 302,
          headers: { location: "/lost?source=redirect#top" },
        }),
      "/lost": () => new Response(null, { status: 500 }),
    },
    [],
    400,
  );
  expect(result.status).toBe(1);
  expect(result.requests).toContain("/lost?source=redirect");
  expect(result.stderr).toContain("/sub/dead (400) <- / /sub/page");
  expect(result.stderr).toContain("/lost (500) <- /redirect /sub/page");
  expect(result.stderr.trimEnd().split("\n").slice(2)).toEqual([
    "  fix or remove the broken href in the referring page(s), or add the missing route/redirect",
  ]);
});

test("check-links preserves the query required by a preloaded server island", async () => {
  const result = await crawlFixture(
    {
      "/": () => html('<link rel="preload" as="fetch" href="/_server-islands/Widget?props=value">'),
      "/_server-islands/Widget?props=value": () => new Response(null, { status: 200 }),
    },
    [],
    400,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.requests).toEqual(["/", "/_server-islands/Widget?props=value"]);
});

test("check-links fetches and counts a path once across query strings and fragments", async () => {
  const result = await crawlFixture({
    "/": ({ origin }) =>
      html(`
      <A HREF="${origin}/item?x=1&amp;y=2#details">item</A>
      <a href="/item?x=2#top">item</a>
    `),
    "/item": () => new Response(null, { status: 204 }),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.requests).toEqual(["/", "/item?x=1&y=2"]);
  expect(result.stdout).toBe("[check-links] 2 paths crawled, 0 broken\n");
});

test("check-links resolves hrefs against the page base and skips the base href itself", async () => {
  const result = await crawlFixture({
    "/": () => html('<a href="/docs/a">page</a>'),
    "/docs/a": () => html('<base href="/assets/"><a href="b">target</a>'),
    "/assets/b": () => new Response(null, { status: 204 }),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.requests).toEqual(["/", "/docs/a", "/assets/b"]);
});

test("check-links decodes ampersands in href paths", async () => {
  const result = await crawlFixture({
    "/": () => html('<a href="/a&amp;b">target</a>'),
    "/a&b": () => new Response(null, { status: 204 }),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.requests).toEqual(["/", "/a&b"]);
});

type HttpRoute = (request: IncomingMessage, response: ServerResponse) => void;

function httpFixture(routes: Record<string, HttpRoute>) {
  return createServer((request, response) => {
    const route = routes[String(request.url)];
    if (route) route(request, response);
    else response.writeHead(404).end();
  });
}

test("check-links reports a rejected fetch with its referrer and continues crawling", async () => {
  const server = httpFixture({
    "/": (_, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<a href="/page">page</a>');
    },
    "/page": (_, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<a href="/reset">reset</a><a href="/next">next</a>');
    },
    "/reset": (request) => request.socket.destroy(),
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert(address, "expected a TCP listener");
    assert(typeof address === "object", "expected a TCP listener address");
    const url = `http://127.0.0.1:${address.port}`;
    const [status, stdout, stderr] = await runSiteCommand("check-links", [
      url,
      "--concurrency",
      "1",
    ]);
    expect(status, stderr).toBe(1);
    const reset = stderr.split("\n").find((line) => line.startsWith(`  ${url}/reset (`));
    expect(reset).toMatch(/\) <- \/page$/);
    expect(stderr).toContain("/next (404) <- /page");
    expect(stdout).toContain("4 paths crawled, 2 broken");
  } finally {
    server.close();
  }
});

test("check-links skips every specified prefix, including redirect targets", async () => {
  const result = await crawlFixture(
    {
      "/": () => html('<a href="/catalog/item">skip</a><a href="/go">go</a>'),
      "/go": () => new Response(null, { status: 302, headers: { location: "/draft/item" } }),
    },
    ["--skip", "/catalog", "--skip", "/draft"],
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.requests).toEqual(["/", "/go"]);
});

test("check-links ignores external hrefs and redirects and hrefs inside scripts", async () => {
  let externalHits = 0;
  const external = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      externalHits++;
      return new Response(null, { status: 404 });
    },
  });
  try {
    const result = await crawlFixture({
      "/": ({ origin }) =>
        html(`
        <a href="${external.url}">external</a>
        <a href="blob:${origin}/from-blob">blob URL</a>
        <script>const template = '<a href="/from-script">fake</a>';</script>
        <a href="/exit">external redirect</a>
      `),
      "/exit": () => new Response(null, { status: 302, headers: { location: external.url.href } }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests).toEqual(["/", "/exit"]);
    expect(externalHits).toBe(0);
  } finally {
    await external.stop(true);
  }
});

test("check-links fails a site with zero internal links", async () => {
  const result = await crawlFixture({ "/": () => html("<p>No links here.</p>") });
  expect(result.status).toBe(1);
  expect(result.requests).toEqual(["/"]);
  expect(result.stderr).toBe(
    "[check-links] crawl found zero internal links: check that the server serves the built site at / and that --skip does not exclude every internal href\n",
  );
});

test("check-links fails when it cannot fetch the start page", async () => {
  const [status, stdout, stderr] = await runSiteCommand("check-links", ["http://127.0.0.1:0"]);
  expect(status).toBe(1);
  expect(stdout).toContain("1 paths crawled, 1 broken");
  expect(stderr).toMatch(/http:\/\/127\.0\.0\.1:0\/ .* <- start URL/);
});

test.each([1, 2])("check-links honors --concurrency %i", async (concurrency) => {
  let active = 0;
  let peak = 0;
  const readTarget = async () => {
    peak = Math.max(peak, ++active);
    await Bun.sleep(100);
    active--;
    return new Response(null, { status: 204 });
  };
  const result = await crawlFixture(
    {
      "/": () => html('<a href="/a">a</a><a href="/b">b</a>'),
      "/a": readTarget,
      "/b": readTarget,
    },
    ["--concurrency", String(concurrency)],
  );
  expect(result.status, result.stderr).toBe(0);
  expect(peak).toBe(concurrency);
});
