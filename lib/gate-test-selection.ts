import { vitestRun } from "./gate-config.ts";
import { shellQuote } from "./gate-plan.ts";
import { ownEntry } from "./own-entry.ts";
import type { Package } from "./repo.ts";

function configuredTestSource(pkg: Package): string | undefined {
  const { browserTest, test } = pkg.scaffolding ?? {};
  if (browserTest) return `bun ${vitestRun.join(" ")}`;
  if (!test) return undefined;
  const script = ownEntry(pkg.scripts, test);
  if (script === undefined) return test;
  if (ownEntry(pkg.scripts, `pre${test}`) || ownEntry(pkg.scripts, `post${test}`)) return undefined;
  return script;
}

// A shell script that does more than invoke Vitest receives the paths as data.
const vitestInvocation =
  /^((?:env(?: -u [A-Za-z_]\w*)+ )?(?:[A-Za-z_]\w*=[\w.-]+ )*(?:bun --bun )?vitest) run((?: --project [\w.-]+)*)$/;

export function relatedTestCommand(pkg: Package, paths: ReadonlySet<string>): string | undefined {
  const match = vitestInvocation.exec(configuredTestSource(pkg)?.trim() ?? "");
  if (!match) return undefined;
  const [, executable = "", flags = ""] = match;
  if (executable.endsWith("bun --bun vitest") && ownEntry(pkg.scripts, "vitest")) return undefined;
  const browserTest = pkg.scaffolding?.browserTest;
  const exclude = browserTest ? ` --exclude ${shellQuote(`${browserTest}/**`)}` : "";
  const files = [...paths].map((path) => shellQuote(`./${path}`)).join(" ");
  return `${executable} related --run --passWithNoTests --coverage.enabled=false${flags}${exclude} ${files}`;
}
