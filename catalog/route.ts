import { readFileSync } from "node:fs";

// The stylesheets of the home, of a state's page (dashboard) and of a state alone (stories).
export const CSS = "virtual:scaffolding/catalog-css/";

const anchor = "from 'astrobook/client';\n";
const lead = /^const \{[^}:]*\bargs\b[^}:]*\} = parseStoryNamedExport\([^\n]*\);$/m;
const client = " client:load />";
const sidebar = "hasSidebar={true}";

const configImport = "import config from 'virtual:astrobook/global-config.mjs'\n";
const titleTag = "<title>{config.title}</title>";

/** Astrobook's layout (`source`), its one `<title>` for every page replaced by each page's own from
 * `pageTitle` in `words` (the module's path). A layout that reads otherwise fails the build. */
export function retitleLayout(source: string, words: string): string {
  if (!source.includes(configImport) || !source.includes(titleTag))
    throw new Error("catalog: Astrobook's layout has no <title>{config.title}</title> to retitle");
  return source
    .replace(
      configImport,
      `$&import storyModules from 'virtual:astrobook/story-modules.mjs'\nimport { pageTitle } from ${JSON.stringify(words)}\n`,
    )
    .replace(titleTag, "<title>{pageTitle(storyModules, Astro.props.story, config.title)}</title>");
}

/**
 * One route Astrobook wrote under dashboard/ or stories/ (`file`, relative to the codegen folder),
 * rewritten: its route's CSS imported after Astrobook's client import, before the story's; the
 * state's args.lead handed to Head.astro, which renders later; a state's page without Astrobook's
 * sidebar; under `serverOnly` the `client:load` branch dropped. Undefined for a route already rewritten, such as one of a deleted story, which
 * Astrobook leaves. A route that reads otherwise fails the build rather than lose its edit silently.
 */
export function rewriteRoute(
  file: string,
  source: string,
  serverOnly: boolean,
): string | undefined {
  if (source.includes(`import "${CSS}`)) return undefined;
  const kind = file.split(/[\\/]/)[0];
  if (
    !(kind === "dashboard" || kind === "stories") ||
    !source.includes(anchor) ||
    !lead.test(source)
  )
    throw new Error(
      `catalog: Astrobook's route ${file} has no place for its CSS import or its lead`,
    );
  if (kind === "dashboard" && !source.includes(sidebar))
    throw new Error(`catalog: Astrobook's route ${file} has no sidebar for the bar to replace`);
  if (serverOnly && !source.includes(client))
    throw new Error(
      `catalog: Astrobook's route ${file} has no client:load branch for serverOnly to drop`,
    );
  // The bar replaces the sidebar, which listed every state on every state's page, hidden.
  const code = (kind === "dashboard" ? source.replace(sidebar, "hasSidebar={false}") : source)
    .replace(anchor, `$&import "${CSS}${kind}";\n`)
    .replace(lead, "$&\nAstro.locals.hwCatalogLead = args?.lead;");
  return serverOnly ? code.replaceAll(client, " />") : code;
}

/** The route Astrobook wrote at `path` (`file`, relative to the codegen folder), rewritten as Vite
 * loads it; the file on disk stays Astrobook's. Every Astro process on the root rewrites the same
 * files on its setup, Astrobook (0.13.3) in place, so a read can find a route empty or cut while
 * another process writes it: a route that does not rewrite is read again until it does, `waitMs`
 * at most, then fails as rewriteRoute does. Rewritten on disk, a page built or served while another
 * process's setup ran lost its CSS without an error. */
export async function loadRoute(
  path: string,
  file: string,
  serverOnly: boolean,
  waitMs = 2000,
): Promise<string> {
  const until = Date.now() + waitMs;
  for (;;) {
    const source = readFileSync(path, "utf8");
    try {
      return rewriteRoute(file, source, serverOnly) ?? source;
    } catch (e) {
      if (Date.now() >= until) throw e;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
}
