import vitestBase from "@hackersandwizards/scaffolding/vitest";
import strykerBase from "@hackersandwizards/scaffolding/stryker";
import { fc, test } from "@hackersandwizards/scaffolding/property";
import type { PartialStrykerOptions } from "@stryker-mutator/api/core";
import { expectTypeOf } from "vitest";
import type { ViteUserConfig } from "vitest/config";

expectTypeOf(vitestBase).toEqualTypeOf<ViteUserConfig>();
expectTypeOf(strykerBase).toEqualTypeOf<PartialStrykerOptions>();
const stringProperty = test.prop([fc.string()]);
expectTypeOf(stringProperty).parameter(1).parameter(0).toEqualTypeOf<string>();
