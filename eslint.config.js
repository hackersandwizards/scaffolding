import base from "./config/eslint-astro.js";

export default [
  ...base,
  {
    ignores: [
      "template/**/*",
      "!template/.githooks/",
      "!template/.githooks/**",
      "template-catalog/**",
    ],
  },
];
