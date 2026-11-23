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
if (site.pathname !== "/") linksUsageError("the base URL must point to /");
const skips = values.skip ?? [];
if (skips.some((prefix) => !prefix.startsWith("/"))) {
  linksUsageError("--skip requires a path prefix starting with /");
}
const concurrency = Number(values.concurrency ?? 8);
if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
  linksUsageError("--concurrency must be a positive integer");
}

async function crawlSite({ origin, protocol, search }: URL): Promise<number> {
  const status = new Map<string, number | string>();
  const referrers = new Map<string, Set<string>>();
  const redirects = new Map<string, string>();
  const queue = new Map([["/", origin + "/" + search]]);
  const discovered = new Set(queue.keys());
  let links = 0;

  function queueInternalLink(href: string, from: string, base: string | URL): string | undefined {
    const url = URL.parse(href, base);
    if (
      url?.origin !== origin ||
      url.protocol !== protocol ||
      skips.some((prefix) => url.pathname.startsWith(prefix))
    )
      return;
    const target = url.pathname;
    const sources = referrers.get(target) ?? new Set<string>();
    sources.add(from);
    referrers.set(target, sources);
    if (!discovered.has(target)) {
      discovered.add(target);
      queue.set(target, origin + target + url.search);
    }
    return target;
  }

  async function visitLink(path: string, pageUrl: string) {
    const res = await fetch(pageUrl, { redirect: "manual" });
    status.set(path, res.status);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const target = queueInternalLink(location, path, pageUrl);
      if (target !== undefined) redirects.set(path, target);
    } else if (res.ok && res.headers.get("content-type")?.toLowerCase().includes("html")) {
      let base: string | URL | undefined;
      const parser = new HTMLRewriter().on("[href]", {
        element(element) {
          const href = element.getAttribute("href")?.trim().replaceAll("&amp;", "&");
          if (href === undefined) return;
          if (element.tagName === "base") {
            base ??= URL.parse(href, pageUrl) ?? pageUrl;
            return;
          }
          if (
            href &&
            !href.startsWith("#") &&
            queueInternalLink(href, path, base ?? pageUrl) !== undefined
          )
            links++;
        },
      });
      await parser.transform(res).arrayBuffer();
      return;
    }
    await res.body?.cancel();
  }

  const inFlight = new Set<Promise<void>>();
  while (queue.size || inFlight.size) {
    for (const [path, pageUrl] of queue) {
      if (inFlight.size >= concurrency) break;
      queue.delete(path);
      const visit = visitLink(path, pageUrl)
        .catch((error: unknown) => {
          status.set(path, error instanceof Error ? error.message : String(error));
        })
        .finally(() => inFlight.delete(visit));
      inFlight.add(visit);
    }
    await Promise.race(inFlight);
  }

  let broken = 0;
  for (const [path, result] of status) {
    const requestFailed = typeof result === "string";
    if (!requestFailed && result < 400) continue;
    broken++;
    const sources = new Set<string>();
    const via = new Set([path]);
    for (const target of via) {
      for (const from of referrers.get(target) ?? []) {
        sources.add(from);
        if (redirects.get(from) === target) via.add(from);
      }
    }
    const target = requestFailed ? origin + path : path;
    console.error(
      `  ${target} (${result}) <- ${sources.size ? [...sources].join(" ") : "start URL"}`,
    );
  }
  console.log(`[check-links] ${status.size} paths crawled, ${broken} broken`);
  if (links === 0) {
    console.error("[check-links] crawl found zero internal links");
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
