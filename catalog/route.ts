import { globSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** Every route Astrobook wrote into the codegen folder `dir`, rewritten in place. Another Astro
 * process on the same root rewrites the same files at the same time and reads them meanwhile, so
 * each lands whole through a rename: written in place, a file read while it is being written is
 * empty, and that process fails its setup. Astrobook (0.13.3) writes its own routes in place, so
 * a setup reading while another process's Astrobook writes can still fail the same way. */
export function rewriteRoutes(dir: string, serverOnly: boolean): void {
  for (const file of globSync("**/*.astro", { cwd: dir })) {
    const path = join(dir, file);
    const code = rewriteRoute(file, readFileSync(path, "utf8"), serverOnly);
    if (code === undefined) continue;
    writeFileSync(`${path}.${process.pid}`, code);
    renameSync(`${path}.${process.pid}`, path);
  }
}
