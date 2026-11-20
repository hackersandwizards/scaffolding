const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Python-2.0",
  "PSF-2.0",
  "Unlicense",
  "Zlib",
  "WTFPL",
  "OFL-1.1",
  "MPL-2.0",
]);

export function licenceAllowed(expression: string): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const fail = () => {
    throw new Error(expression);
  };
  const atom = (): boolean => {
    const token = tokens[at++];
    if (token === "(") {
      const value = or();
      if (tokens[at++] !== ")") fail();
      return value;
    }
    if (!token || /^(AND|OR|WITH|\))$/.test(token)) fail();
    if (tokens[at] === "WITH" && /^(AND|OR|WITH|\(|\))?$/.test(tokens[(at += 2) - 1] ?? "")) fail();
    return ALLOWED.has(token);
  };
  const and = (): boolean => {
    let value = atom();
    while (tokens[at] === "AND") {
      at++;
      value = atom() && value;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (tokens[at] === "OR") {
      at++;
      value = and() || value;
    }
    return value;
  };
  try {
    const value = or();
    return at === tokens.length && value;
  } catch {
    return false;
  }
}
