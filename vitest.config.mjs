import base from "@hackersandwizards/scaffolding/vitest";
import { mergeConfig } from "vitest/config";

export default mergeConfig(base, {
  test: {
    exclude: process.env.SCAFFOLDING_CHANGED === "1" ? ["test/{checks,check-lock}.test.ts"] : [],
  },
});
