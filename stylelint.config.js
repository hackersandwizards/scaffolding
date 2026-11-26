import styles from "@hackersandwizards/scaffolding/stylelint";

const base = styles();

export default {
  ...base,
  overrides: [
    ...base.overrides,
    {
      // The catalog build expands the brand-value() macro in these two properties. See docs/catalog.md.
      files: ["catalog/chrome.css"],
      rules: {
        "scaffolding/declaration-property-value-no-unknown": [
          true,
          {
            ignoreProperties: {
              "font-size": "/^brand-value\\(/",
              "line-height": "/^brand-value\\(/",
            },
          },
        ],
      },
    },
  ],
};
