import { defined } from "@hackersandwizards/scaffolding/defined";
import vitestBase from "@hackersandwizards/scaffolding/vitest";
import strykerBase from "@hackersandwizards/scaffolding/stryker";
import type { PartialStrykerOptions } from "@stryker-mutator/api/core";
import { expectTypeOf } from "vitest";
import type { ViteUserConfig } from "vitest/config";

expectTypeOf(vitestBase).toEqualTypeOf<ViteUserConfig>();
expectTypeOf(strykerBase).toEqualTypeOf<PartialStrykerOptions>();
expectTypeOf(defined<string>).returns.toEqualTypeOf<string>();
