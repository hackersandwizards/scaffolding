import ts from "typescript";

export function unwrapTypeExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression;
  return current;
}

export function hoistedVariableDeclarations(node: ts.Node): ts.VariableDeclaration[] {
  if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isModuleDeclaration(node)) return [];
  if (ts.isVariableDeclarationList(node))
    return node.flags & ts.NodeFlags.BlockScoped ? [] : [...node.declarations];
  const found: ts.VariableDeclaration[] = [];
  ts.forEachChild(node, (child) => {
    found.push(...hoistedVariableDeclarations(child));
  });
  return found;
}

export function moduleVariableBindings(source: ts.SourceFile): ts.VariableDeclaration[] {
  const bindings: ts.VariableDeclaration[] = [];
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) bindings.push(...statement.declarationList.declarations);
    else bindings.push(...hoistedVariableDeclarations(statement));
  }
  return bindings;
}

export function isFunctionInitializer(expression: ts.Expression): boolean {
  const unwrapped = unwrapTypeExpression(expression);
  return ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped);
}

export function* moduleFunctionNames(source: ts.SourceFile): Generator<string> {
  for (const statement of source.statements)
    if (ts.isFunctionDeclaration(statement) && statement.body && statement.name)
      yield statement.name.text;
  for (const { name, initializer } of moduleVariableBindings(source))
    if (ts.isIdentifier(name) && initializer && isFunctionInitializer(initializer)) yield name.text;
}
