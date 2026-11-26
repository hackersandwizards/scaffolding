import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";

const component = readFileSync(new URL("../catalog/Head.astro", import.meta.url), "utf8");
const script = component.split("<script is:inline>")[1]!.split("</script>")[0]!;
const exposed = script.replace(
  "    // The arrow keys step",
  "    globalThis.followCatalogStateLink = followCatalogStateLink;\n    // The arrow keys step",
);

test.each([{ key: "constructor", expected: 0 }])(
  "does not look up a navigation link for the %s key",
  ({ key, expected }) => {
    const querySelector = vi.fn();
    const browser = {
      followCatalogStateLink: (_event: { key: string }) => {
        throw new Error("missing catalog navigation script");
      },
      document: {
        documentElement: { dataset: {} },
        getElementById: () => null,
        addEventListener: vi.fn(),
        querySelector,
      },
      HTMLTemplateElement: class {},
      HTMLAnchorElement: class {},
    };
    runInNewContext(exposed, browser);
    browser.followCatalogStateLink({ key });
    expect(querySelector).toHaveBeenCalledTimes(expected);
  },
);
