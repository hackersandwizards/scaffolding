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

type LicenceGroup = {
  allowedAlternative: boolean;
  term: boolean;
  needsOperand: boolean;
};

const licenceGroup = (): LicenceGroup => ({
  allowedAlternative: false,
  term: true,
  needsOperand: true,
});

const groupLicenceAllowed = (group: LicenceGroup) => group.allowedAlternative || group.term;

function addLicenceOperand(group: LicenceGroup, allowed: boolean): void {
  group.term = group.term && allowed;
  group.needsOperand = false;
}

function readLicenceOperator(groups: LicenceGroup[], group: LicenceGroup, token: string): boolean {
  switch (token) {
    case "AND":
      group.needsOperand = true;
      return true;
    case "OR":
      group.allowedAlternative = groupLicenceAllowed(group);
      group.term = true;
      group.needsOperand = true;
      return true;
    case ")": {
      const parent = groups.at(-2);
      if (!parent) return false;
      addLicenceOperand(parent, groupLicenceAllowed(group));
      groups.pop();
      return true;
    }
    default:
      return false;
  }
}

const licenceIdentifier = (token: string | undefined): token is string =>
  token !== undefined && !/^(AND|OR|WITH|\(|\))$/.test(token);

function readLicenceAtom(tokens: string[], at: number) {
  const token = tokens[at];
  if (!licenceIdentifier(token)) return undefined;
  if (tokens[at + 1] !== "WITH") return { token, next: at + 1 };
  if (!licenceIdentifier(tokens[at + 2])) return undefined;
  return { token, next: at + 3 };
}

export function licenceAllowed(expression: string): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  const root = licenceGroup();
  const groups = [root];
  for (let at = 0; at < tokens.length;) {
    const group = groups.at(-1);
    if (!group) return false;
    const token = tokens[at];
    if (!group.needsOperand) {
      if (!readLicenceOperator(groups, group, token)) return false;
      at++;
    } else if (token === "(") {
      groups.push(licenceGroup());
      at++;
    } else {
      const atom = readLicenceAtom(tokens, at);
      if (!atom) return false;
      addLicenceOperand(group, ALLOWED.has(atom.token));
      at = atom.next;
    }
  }
  return groups.length === 1 && !root.needsOperand && groupLicenceAllowed(root);
}
