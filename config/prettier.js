// The formatting every repository shares, as Prettier's shareable config. A repository without
// plugins points at it from package.json (`"prettier": "@hackersandwizards/scaffolding/prettier"`);
// one with plugins spreads it in its own prettier.config.js.
export default { semi: true, singleQuote: false, trailingComma: "all", printWidth: 100 };
