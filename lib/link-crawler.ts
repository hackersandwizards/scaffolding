export type PageOutcome =
  | { status: number; redirect: URL | null }
  | { status: number; links: URL[] }
  | { status: number }
  | { error: string };

export type CrawlSummary = {
  status: Map<string, number | string>;
  referrers: Map<string, Set<string>>;
  redirects: Map<string, string>;
  links: number;
};

export function isInternalUrl(url: URL, site: URL, skips: readonly string[]): boolean {
  return (
    url.origin === site.origin &&
    url.protocol === site.protocol &&
    !skips.some((prefix) => url.pathname.startsWith(prefix))
  );
}

export async function extractHtmlUrls(response: Response, pageUrl: string): Promise<URL[]> {
  let base: string | URL | undefined;
  const urls: URL[] = [];
  const parser = new HTMLRewriter().on("[href]", {
    element(element) {
      const raw = element.getAttribute("href");
      if (raw === null) return;
      const href = raw.trim().replaceAll("&amp;", "&");
      if (element.tagName === "base") {
        base ??= URL.parse(href, pageUrl) ?? pageUrl;
        return;
      }
      if (!href || href.startsWith("#")) return;
      const resolved = URL.parse(href, base ?? pageUrl);
      if (resolved) urls.push(resolved);
    },
  });
  await parser.transform(response).arrayBuffer();
  return urls;
}

export function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return contentType !== null && contentType.toLowerCase().includes("html");
}

export async function fetchPageLinks(pageUrl: string): Promise<PageOutcome> {
  try {
    const res = await fetch(pageUrl, { redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      return { status: res.status, redirect: URL.parse(location, pageUrl) };
    }
    if (res.ok && isHtmlResponse(res)) {
      return { status: res.status, links: await extractHtmlUrls(res, pageUrl) };
    }
    await res.body?.cancel();
    return { status: res.status };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function traceReferrers(
  path: string,
  referrers: ReadonlyMap<string, ReadonlySet<string>>,
  redirects: ReadonlyMap<string, string>,
): string[] {
  const sources = new Set<string>();
  const via = new Set([path]);
  for (const target of via) {
    for (const from of referrers.get(target) ?? []) {
      sources.add(from);
      if (redirects.get(from) === target) via.add(from);
    }
  }
  return [...sources];
}

export function formatBrokenLink(
  target: string,
  result: number | string,
  sources: readonly string[],
): string {
  return `  ${target} (${result}) <- ${sources.length ? sources.join(" ") : "start URL"}`;
}

export function brokenLinkLines(origin: string, crawl: CrawlSummary): string[] {
  const lines: string[] = [];
  for (const [path, result] of crawl.status) {
    const requestFailed = typeof result === "string";
    if (!requestFailed && result < 400) continue;
    const sources = traceReferrers(path, crawl.referrers, crawl.redirects);
    const target = requestFailed ? origin + path : path;
    lines.push(formatBrokenLink(target, result, sources));
  }
  return lines;
}

export class LinkCrawl {
  readonly status = new Map<string, number | string>();
  readonly referrers = new Map<string, Set<string>>();
  readonly redirects = new Map<string, string>();
  readonly queue: Map<string, string>;
  private readonly discovered: Set<string>;
  private readonly site: URL;
  private readonly skips: readonly string[];
  links = 0;

  constructor(site: URL, skips: readonly string[]) {
    this.site = site;
    this.skips = skips;
    this.queue = new Map([["/", site.origin + "/" + site.search]]);
    this.discovered = new Set(this.queue.keys());
  }

  enqueue(url: URL, from: string): string | undefined {
    if (!isInternalUrl(url, this.site, this.skips)) return undefined;
    const target = url.pathname;
    const sources = this.referrers.get(target) ?? new Set<string>();
    sources.add(from);
    this.referrers.set(target, sources);
    if (!this.discovered.has(target)) {
      this.discovered.add(target);
      this.queue.set(target, this.site.origin + target + url.search);
    }
    return target;
  }

  recordOutcome(path: string, outcome: PageOutcome): void {
    if ("error" in outcome) {
      this.status.set(path, outcome.error);
      return;
    }
    this.status.set(path, outcome.status);
    if ("redirect" in outcome && outcome.redirect) {
      const target = this.enqueue(outcome.redirect, path);
      if (target !== undefined) this.redirects.set(path, target);
    } else if ("links" in outcome) {
      for (const url of outcome.links) if (this.enqueue(url, path) !== undefined) this.links++;
    }
  }
}
