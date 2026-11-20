import { mergeConfig } from "vitest/config";
import base from "./vitest.config.mjs";

export default mergeConfig(base, {
  test: {
    include: ["test/{rejection,package-exports,confidential-input}.test.ts", "test/*.prop.test.ts"],
  },
});
