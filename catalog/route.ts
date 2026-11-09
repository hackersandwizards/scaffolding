// The stylesheets of the home, of a state's page (dashboard) and of a state alone (stories).
export const CSS = "virtual:scaffolding/catalog-css/";

const anchor = "from 'astrobook/client';\n";
const lead = /^const \{[^}:]*\bargs\b[^}:]*\} = parseStoryNamedExport\([^\n]*\);$/m;
const client = " client:load />";

/**
 * One route Astrobook wrote under dashboard/ or stories/ (`file`, relative to the codegen folder),
 * rewritten: its route's CSS imported after Astrobook's client import, before the story's; the
 * state's args.lead handed to Head.astro, which renders later; under `serverOnly` the `client:load`
 * branch dropped. Undefined for a route already rewritten, such as one of a deleted story, which
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
  if (serverOnly && !source.includes(client))
    throw new Error(
      `catalog: Astrobook's route ${file} has no client:load branch for serverOnly to drop`,
    );
  const code = source
    .replace(anchor, `$&import "${CSS}${kind}";\n`)
    .replace(lead, "$&\nAstro.locals.hwCatalogLead = args?.lead;");
  return serverOnly ? code.replace(client, " />") : code;
}
