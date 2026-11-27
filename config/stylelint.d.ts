import type { Config } from "stylelint";

type Overrides = NonNullable<Config["overrides"]>;

export default function styles(options?: {
  importFrom?: readonly string[] | undefined;
}): Config & { overrides: Overrides };
