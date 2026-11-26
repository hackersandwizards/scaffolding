import { expect, test } from "vitest";
import { javascriptScriptRange } from "../config/eslint-astro.js";

test.each([
  {
    node: {
      openingElement: {
        end: 9,
        attributes: [
          {
            name: { name: "TYPE" },
            value: { type: "Literal", value: "TEXT/ECMASCRIPT ; charset=utf-8" },
          },
        ],
      },
      closingElement: { start: 15 },
    },
    expected: [9, 15],
  },
])(
  "reports script offsets for a case-insensitive MIME type with parameters",
  ({ node, expected }) => {
    expect(javascriptScriptRange(node)).toEqual(expected);
  },
);
