#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { parseArgs } from "node:util";
import { help } from "../lib/help.ts";
import { brokenLinkLines, LinkCrawl } from "../lib/link-crawler.ts";

const usage = "usage: check-links <base url> [--skip <path prefix>]... [--concurrency <n>]";
help("check-links", usage);

function linksUsageError(message: string): never {
  console.error(`[check-links] ${message}\n${usage}`);
  process.exit(2);
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: { skip: { type: "string", multiple: true }, concurrency: { type: "string" } },
    });
  } catch (error) {
    return linksUsageError(String(error));
  }
})();
const [base] = positionals;
const site = base && URL.parse(base);
if (positionals.length !== 1 || !site || !["http:", "https:"].includes(site.protocol)) {
  linksUsageError("expected an HTTP or HTTPS base URL");
}
if (site.pathname !== "/") linksUsageError("the base URL must point to /");
const skips = values.skip ?? [];
if (skips.some((prefix) => !prefix.startsWith("/"))) {
  linksUsageError("--skip requires a path prefix starting with /");
}
const concurrency = Number(values.concurrency ?? 8);
if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
  linksUsageError("--concurrency must be a positive integer");
}

async function crawlSite(site: URL): Promise<number> {
  const crawl = new LinkCrawl(site, skips);
  const inFlight = new Set<Promise<void>>();
  while (crawl.queue.size || inFlight.size) {
    for (const [path, pageUrl] of crawl.queue) {
      if (inFlight.size >= concurrency) break;
      crawl.queue.delete(path);
      const visit = crawl.visitPage(path, pageUrl).finally(() => inFlight.delete(visit));
      inFlight.add(visit);
    }
    await Promise.race(inFlight);
  }

  const broken = brokenLinkLines(site.origin, crawl);
  for (const line of broken) console.error(line);
  if (broken.length)
    console.error(
      "  fix or remove the broken href in the referring page(s), or add the missing route/redirect",
    );
  console.log(`[check-links] ${crawl.status.size} paths crawled, ${broken.length} broken`);
  if (crawl.links === 0) {
    console.error(
      "[check-links] crawl found zero internal links: check that the server serves the built site at / and that --skip does not exclude every internal href",
    );
    return 1;
  }
  return broken.length ? 1 : 0;
}

try {
  process.exitCode = await crawlSite(site);
} catch (error) {
  console.error(`[check-links] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
