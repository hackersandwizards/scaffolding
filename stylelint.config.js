import styles from "@hackersandwizards/scaffolding/stylelint";

const base = styles();

export default {
  ...base,
  overrides: [
    ...base.overrides,
    {
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
