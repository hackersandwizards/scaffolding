import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function testDirectory() {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "scaffolding-unit-")));
  return {
    folder,
    [Symbol.dispose]() {
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
