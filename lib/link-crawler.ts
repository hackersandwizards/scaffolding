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

export async function extractHtmlUrls(
  response: Response,
  pageUrl: string,
  onUrl: (url: URL) => void,
): Promise<void> {
  let base: string | URL | undefined;
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
      if (resolved) onUrl(resolved);
    },
  });
  await parser.transform(response).arrayBuffer();
}

export function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return contentType !== null && contentType.toLowerCase().includes("html");
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

  private recordRedirect(path: string, pageUrl: string, location: string): void {
    const resolved = URL.parse(location, pageUrl);
    const target = resolved ? this.enqueue(resolved, path) : undefined;
    if (target !== undefined) this.redirects.set(path, target);
  }

  async visitPage(path: string, pageUrl: string): Promise<void> {
    try {
      const res = await fetch(pageUrl, { redirect: "manual" });
      this.status.set(path, res.status);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        this.recordRedirect(path, pageUrl, location);
        return;
      }
      if (!res.ok || !isHtmlResponse(res)) {
        await res.body?.cancel();
        return;
      }
      await extractHtmlUrls(res, pageUrl, (url) => {
        if (this.enqueue(url, path) !== undefined) this.links++;
      });
    } catch (error: unknown) {
      this.status.set(path, error instanceof Error ? error.message : String(error));
    }
  }
}
