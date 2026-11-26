import { mock } from "bun:test";
import * as pins from "../lib/pinned-binary.ts";

const binaries = JSON.parse(process.env.SCAFFOLDING_TEST_BINARIES ?? "{}") as Record<
  string,
  string
>;
await mock.module("../lib/pinned-binary.ts", () => ({
  ...pins,
  pinnedBinary: (_root: string, tool: string) => {
    const binary = binaries[tool];
    if (!binary) throw new Error(`unexpected pinned binary request for ${tool}`);
    return Promise.resolve(binary);
  },
}));
