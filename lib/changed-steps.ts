export function validGlob(pattern: string): boolean {
  if (
    !pattern.trim() ||
    pattern.includes("\0") ||
    pattern.split("/").some((part) => ["", ".", ".."].includes(part))
  )
    return false;
  const outsideClasses = pattern.replace(/\\[^\n]|\[[^\]]+\]/g, "");
  if (/[[\]\\]/.test(outsideClasses)) return false;
  let depth = 0;
  for (const char of outsideClasses) {
    if (char === "{") depth++;
    if (char === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

const always = ["format", "structure", "coupling", "spaces", "confidential", "licenses", "admin"];
const source = ["typecheck", "lint", "oxlint", "cycles", "test"];
const defaults = [
  { glob: new Bun.Glob("**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts,astro,mdx}"), steps: source },
  { glob: new Bun.Glob("**/*.{astro,mdx,css,scss,sass,less}"), steps: ["styles", "test"] },
  {
    glob: new Bun.Glob(
      "{src,app,lib,bin,components,pages,catalog,site,talks,scripts,test,tests,fixtures,data,content,public,assets,e2e}/**",
    ),
    steps: [...source, "styles"],
  },
  { glob: new Bun.Glob("docs/**/*.{md,txt}"), steps: [] },
  { glob: new Bun.Glob("{README,CONTRIBUTING,SECURITY,CLAUDE,AGENTS}.md"), steps: [] },
  { glob: new Bun.Glob(".claude/rules/**/*.md"), steps: [] },
  { glob: new Bun.Glob(".claude/skills/**/*.{md,yaml,yml}"), steps: [] },
];
const crossCutting = [
  "**/package.json",
  "**/{bun.lock,bun.lockb,package-lock.json,pnpm-lock.yaml,yarn.lock,bunfig.toml,.npmrc}",
  "**/{tsconfig*.json,eslint.config.*,oxlint.config.*,.oxlintrc*,prettier.config.*,.prettierrc*,.prettierignore,stylelint.config.*,.stylelintrc*,.stylelintignore,astro.config.*,vite.config.*,vitest.config.*,playwright*.config.*}",
  ".gitmodules",
  ".githooks/**",
  ".github/workflows/**",
  ".gitlab-ci.yml",
].map((glob) => new Bun.Glob(glob));

type Mapping = { glob: Bun.Glob; steps: string[] };

export const fastSteps = (available: string[], fullOnly: ReadonlyMap<string, string>) =>
  new Set(available.filter((step) => !fullOnly.has(step)));

export const allChangedSteps = (fast: ReadonlySet<string>, why: string) =>
  new Map([...fast].map((step) => [step, why]));

export function selectChangedSteps(
  paths: string[],
  fast: ReadonlySet<string>,
  local: string[],
  mappings: Mapping[],
): { steps: Map<string, string>; fallback?: string } {
  const fallback = (why: string) => ({ steps: allChangedSteps(fast, why), fallback: why });
  const steps = new Map(
    always.filter((step) => fast.has(step)).map((step) => [step, "runs on every changed check"]),
  );
  const scoped = new Set(mappings.flatMap(({ steps }) => steps));
  for (const step of local)
    if (step.startsWith("check:") && !scoped.has(step) && fast.has(step))
      steps.set(step, "no path scope configured");
  const map = [...defaults, ...mappings];
  for (const path of paths) {
    if (crossCutting.some((glob) => glob.match(path)))
      return fallback(`${JSON.stringify(path)} is a shared configuration path`);
    const hits = map.filter(({ glob }) => glob.match(path));
    if (!hits.length) return fallback(`${JSON.stringify(path)} matches no path glob`);
    for (const { steps: matched } of hits)
      for (const step of matched)
        if (fast.has(step) && !steps.has(step)) steps.set(step, `matches ${JSON.stringify(path)}`);
  }
  return { steps };
}
