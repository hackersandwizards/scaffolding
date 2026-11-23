#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { parseArgs } from "node:util";
import { help } from "../lib/help.ts";

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
const skips = values.skip ?? [];
if (skips.some((prefix) => !prefix.startsWith("/"))) {
  linksUsageError("--skip requires a path prefix starting with /");
}
const concurrency = Number(values.concurrency ?? 8);
if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
  linksUsageError("--concurrency must be a positive integer");
}

async function crawlSite({ origin, protocol }: URL): Promise<number> {
  const status = new Map<string, number>();
  const referrers = new Map<string, Set<string>>();
  const redirects = new Map<string, string>();
  const queue = new Set(["/"]);
  const discovered = new Set(queue);
  let links = 0;

  function queueInternalLink(href: string, from: string): string | undefined {
    const url = URL.parse(href, origin + from);
    if (
      url?.origin !== origin ||
      url.protocol !== protocol ||
      skips.some((prefix) => url.pathname.startsWith(prefix))
    )
      return;
    const target = url.pathname + url.search;
    const sources = referrers.get(target) ?? new Set<string>();
    sources.add(from);
    referrers.set(target, sources);
    if (!discovered.has(target)) {
      discovered.add(target);
      queue.add(target);
    }
    return target;
  }

  async function visitLink(path: string) {
    const res = await fetch(origin + path, { redirect: "manual" });
    status.set(path, res.status);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const target = queueInternalLink(location, path);
      if (target !== undefined) redirects.set(path, target);
    } else if (res.ok && res.headers.get("content-type")?.toLowerCase().includes("html")) {
      const parser = new HTMLRewriter().on("[href]", {
        element(element) {
          const href = element.getAttribute("href")?.trim();
          if (!href || href.startsWith("#") || element.tagName === "script") return;
          if (queueInternalLink(href.replaceAll("&amp;", "&"), path) !== undefined) links++;
        },
      });
      await parser.transform(res).arrayBuffer();
      return;
    }
    await res.body?.cancel();
  }

  const inFlight = new Set<Promise<void>>();
  while (queue.size || inFlight.size) {
    for (const path of queue) {
      if (inFlight.size >= concurrency) break;
      queue.delete(path);
      const visit = visitLink(path).finally(() => inFlight.delete(visit));
      inFlight.add(visit);
    }
    await Promise.race(inFlight);
  }

  let broken = 0;
  for (const [path, code] of status) {
    if (code < 400) continue;
    broken++;
    const sources = new Set<string>();
    const via = new Set([path]);
    for (const target of via) {
      for (const from of referrers.get(target) ?? []) {
        sources.add(from);
        if (redirects.get(from) === target) via.add(from);
      }
    }
    console.error(`  ${path} (${code}) <- ${sources.size ? [...sources].join(" ") : "start URL"}`);
  }
  console.log(`[check-links] ${status.size} URLs crawled, ${broken} broken`);
  if (status.size === 0 || links === 0) {
    console.error("[check-links] crawl fetched zero pages or found zero internal links");
    return 1;
  }
  return broken ? 1 : 0;
}

try {
  process.exitCode = await crawlSite(site);
} catch (error) {
  console.error(`[check-links] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
