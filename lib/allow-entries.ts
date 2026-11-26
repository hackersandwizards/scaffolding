import { isReason, type Finding, type Package } from "./repo.ts";

export type AllowEntry = {
  check?: string;
  path?: string | string[];
  text?: string | string[];
  reason?: unknown;
};

// `**/` also stands for no folder at all, as in Git and Bun.Glob: `**/x.ts` covers the root's x.ts.
const glob = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split(/(\*\*\/?)/)
      .map((part) =>
        part === "**/"
          ? "(?:.*/)?"
          : part === "**"
            ? ".*"
            : part
                .split("*")
                .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
                .join("[^/]*"),
      )
      .join("")}$`,
  );

// Folded as the confidential scan reads text: NFKC words joined by one space, in lower case.
const fold = (s: string) =>
  (s.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).join(" ").toLowerCase();

// A longer term containing the entry's ("<name> Consulting") stays red.
const textCovers = (text: string, f: Finding) =>
  f.term ? fold(f.text) === fold(text) : f.text.includes(text);

// "file names" in `path` keeps the entry to terms in a file's path: alone in every file, beside
// paths in those files only, so a term in the same files' text stays red.
const NAMES = "file names";
const covers = (entry: AllowEntry, f: Finding, text = entry.text) => {
  const paths = entry.path === undefined ? [] : [entry.path].flat();
  const globs = paths.filter((p) => p !== NAMES);
  return (
    entry.check === f.check &&
    (!paths.includes(NAMES) || f.name === true) &&
    (!globs.length || globs.some((p) => glob(p).test(f.path))) &&
    (text === undefined || [text].flat().some((t) => textCovers(t, f)))
  );
};

const staleMessage =
  "allow entry matches nothing: remove this stale entry (or unused path/text item) from package.json scaffolding.allow";

/** A path or text that is not a string, or a list of strings, threw inside the match. */
export function allowText(value: unknown) {
  return (
    value === undefined ||
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

export function* unmatchedAllowItems(entry: AllowEntry, findings: Finding[]): Iterable<AllowEntry> {
  if (!findings.some((finding) => covers(entry, finding))) {
    yield entry;
    return;
  }
  // Each text and each path of a list is its own exception and dies with its own case.
  const pathname = entry.path;
  const paths = Array.isArray(pathname) ? pathname : [];
  // "file names" qualifies the paths beside it, which each keep it.
  const names = paths.includes(NAMES) ? [NAMES] : [];
  for (const path of paths.filter((item) => item !== NAMES)) {
    if (!findings.some((finding) => covers({ ...entry, path: [...names, path] }, finding)))
      yield { ...entry, path };
  }
  const sourceText = entry.text;
  for (const text of Array.isArray(sourceText) ? sourceText : []) {
    if (!findings.some((finding) => covers(entry, finding, text))) yield { ...entry, text };
  }
}

export function formatAllowFinding(check: string, entry: AllowEntry, message: string): Finding {
  return { check, path: "package.json", text: JSON.stringify(entry), message };
}

/** The package.json is from the same snapshot as the findings, so a commit can add a case
 * and its entry together. A complete review can also detect an exception whose case vanished. */
export class CheckAllowEntries {
  private readonly entries: AllowEntry[];
  private readonly usable: AllowEntry[];
  private readonly check: string;

  constructor(pkg: Package, check: string) {
    this.check = check;
    const allow = pkg.scaffolding?.allow ?? [];
    this.entries = allow.filter((entry) => entry.check === check);
    this.usable = this.entries.filter((entry) => allowText(entry.path) && allowText(entry.text));
  }

  apply(findings: Finding[]) {
    return this.review(findings);
  }

  audit(findings: Finding[]) {
    return this.review(findings, unmatchedAllowItems);
  }

  private review(findings: Finding[], unused?: typeof unmatchedAllowItems): Finding[] {
    const left = findings.filter((finding) => !this.usable.some((entry) => covers(entry, finding)));
    for (const entry of this.entries) {
      if (!this.usable.includes(entry))
        left.push(
          formatAllowFinding(
            this.check,
            entry,
            "allow entry's path and text are strings or lists of strings: fix this entry in package.json scaffolding.allow so path and text (when set) are each a string or string[]",
          ),
        );
      else if (!isReason(entry.reason))
        left.push(
          formatAllowFinding(
            this.check,
            entry,
            'allow entry without a reason: fix the underlying finding and remove this package.json scaffolding.allow entry, or add a non-empty "reason" explaining why the exception is required',
          ),
        );
      else if (unused)
        for (const item of unused(entry, findings))
          left.push(formatAllowFinding(this.check, item, staleMessage));
    }
    return left;
  }
}
