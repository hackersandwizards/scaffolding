import type { ChangedFilesResult } from "./changed-paths.ts";
import {
  dockerfileInput,
  pythonInput,
  terraformInput,
  workflowInput,
} from "./extra-lint-inputs.ts";
import { layerMapPath } from "./layers.ts";

const always = [
  "format",
  "structure",
  "coupling",
  "spaces",
  "confidential",
  "licenses",
  "admin",
  "pins",
  "colours",
  "copies",
];
const source = ["typecheck", "lint", "oxlint", "cycles", "names", "layers", "test"];
const defaults = [
  { glob: { match: pythonInput }, steps: ["python", "test"] },
  { glob: { match: terraformInput }, steps: ["terraform"] },
  { glob: { match: dockerfileInput }, steps: ["dockerfile"] },
  { glob: { match: workflowInput }, steps: ["workflows"] },
  { glob: new Bun.Glob("pyproject.toml"), steps: ["python", "test"] },
  { glob: new Bun.Glob("{ruff.toml,.ruff.toml}"), steps: ["python"] },
  { glob: new Bun.Glob(".tflint.hcl"), steps: ["terraform"] },
  { glob: new Bun.Glob(".hadolint.{yaml,yml}"), steps: ["dockerfile"] },
  { glob: new Bun.Glob(".github/actionlint.{yaml,yml}"), steps: ["workflows"] },
  { glob: new Bun.Glob(layerMapPath), steps: ["layers"] },
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
const additional = [
  { glob: new Bun.Glob("**/*.md"), steps: ["markdown"] },
  { glob: new Bun.Glob("**/*.{sh,bash}"), steps: ["shell"] },
  { glob: new Bun.Glob("**/.shellcheckrc"), steps: ["shell"] },
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

type Mapping = { glob: Pick<Bun.Glob, "match">; steps: string[] };

export const fastSteps = (available: string[], fullOnly: ReadonlyMap<string, string>) =>
  new Set(available.filter((step) => !fullOnly.has(step)));

export const allChangedSteps = (fast: ReadonlySet<string>, why: string) =>
  new Map([...fast].map((step) => [step, why]));

type ChangedFiles = Omit<Exclude<ChangedFilesResult, { fallback: string }>, "paths"> & {
  paths: Iterable<string>;
};

export function configuredPathMatches(path: string, mappings: Mapping[]): Mapping[] | string {
  if (crossCutting.some((glob) => glob.match(path)))
    return `${JSON.stringify(path)} is a shared configuration path`;
  const hits = mappings.filter(({ glob }) => glob.match(path));
  if (!hits.length) return `${JSON.stringify(path)} matches no path glob`;
  return hits;
}

export function* changedPathReasons(path: string, hits: Mapping[], changes: ChangedFiles) {
  if (changes.shellShebangs.has(path))
    yield { step: "shell", reason: `matches shell shebang in ${JSON.stringify(path)}` };
  if (changes.sourcedPaths.has(path))
    yield { step: "shell", reason: `sources ${JSON.stringify(path)}` };
  for (const { steps } of [...hits, ...additional.filter(({ glob }) => glob.match(path))]) {
    for (const step of steps) yield { step, reason: `matches ${JSON.stringify(path)}` };
  }
}

export class ChangedStepSelector {
  private readonly fast: ReadonlySet<string>;
  private readonly local: string[];
  private readonly mappings: Mapping[];

  constructor(fast: ReadonlySet<string>, local: string[], mappings: Mapping[]) {
    this.fast = fast;
    this.local = local;
    this.mappings = mappings;
  }

  select(changes: ChangedFiles): { steps: Map<string, string>; fallback?: string } {
    const { fast } = this;
    const steps = new Map(
      always.filter((step) => fast.has(step)).map((step) => [step, "runs on every changed check"]),
    );
    const scoped = new Set(this.mappings.flatMap(({ steps }) => steps));
    for (const step of this.local)
      if (step.startsWith("check:") && !scoped.has(step) && fast.has(step))
        steps.set(step, "no path scope configured");
    const map = [...defaults, ...this.mappings];
    for (const path of changes.paths) {
      const hits = configuredPathMatches(path, map);
      if (typeof hits === "string") return { steps: allChangedSteps(fast, hits), fallback: hits };
      for (const { step, reason } of changedPathReasons(path, hits, changes))
        if (fast.has(step) && !steps.has(step)) steps.set(step, reason);
    }
    return { steps };
  }
}
