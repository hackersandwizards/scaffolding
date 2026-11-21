import ts from "typescript";

const inheritedNames = new Set(Object.getOwnPropertyNames(Object.prototype));
const keyCallbacks = new Set(["every", "filter", "find", "flatMap", "forEach", "map", "some"]);

function unwrapLookup(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression;
  return node;
}

function exitsLookupBranch(statement, use) {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isContinueStatement(statement)) {
    for (let parent = statement.parent; parent; parent = parent.parent) {
      if (
        statement.label &&
        ts.isLabeledStatement(parent) &&
        parent.label.text === statement.label.text
      )
        return use.end <= parent.end;
      if (!statement.label && ts.isIterationStatement(parent, false)) return use.end <= parent.end;
    }
  }
  return (
    ts.isBlock(statement) &&
    statement.statements.length > 0 &&
    exitsLookupBranch(statement.statements.at(-1), use)
  );
}

function lookupReturns(factory) {
  if (!factory?.body) return [];
  if (!ts.isBlock(factory.body)) return [factory.body];
  const values = [];
  const visit = (child) => {
    if (ts.isReturnStatement(child)) values.push(child.expression);
    else if (!ts.isFunctionLike(child)) ts.forEachChild(child, visit);
  };
  visit(factory.body);
  return values;
}

function lookupWrite(node) {
  let target = node;
  while (ts.isParenthesizedExpression(target.parent) || ts.isNonNullExpression(target.parent))
    target = target.parent;
  const parent = target.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === target &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
    return "write";
  return ts.isWriteAccess(target) ? "update" : undefined;
}

function lookupTest(node) {
  let expression = node;
  let parent = expression.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    (ts.isBinaryExpression(parent) &&
      parent.right === expression &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken))
  ) {
    expression = parent;
    parent = expression.parent;
  }
  if (
    ((ts.isIfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isForStatement(parent)) &&
      parent.expression === expression) ||
    (ts.isConditionalExpression(parent) && parent.condition === expression) ||
    (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken)
  )
    return "truthy";
  const typeQuery = ts.isTypeOfExpression(parent);
  if (typeQuery) {
    expression = parent;
    parent = parent.parent;
  }
  if (!ts.isBinaryExpression(parent)) return "read";
  const operator = parent.operatorToken.kind;
  if (parent.left === expression) {
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken
    )
      return "truthy";
    if (operator === ts.SyntaxKind.QuestionQuestionToken) return "definedness";
  }
  if (
    [
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(operator)
  ) {
    const other = unwrapLookup(parent.left === expression ? parent.right : parent.left);
    if (typeQuery)
      return ts.isStringLiteralLike(other) && other.text === "undefined" ? "definedness" : "read";
    if (
      other.kind === ts.SyntaxKind.NullKeyword ||
      ts.isVoidExpression(other) ||
      (ts.isIdentifier(other) && other.text === "undefined")
    )
      return "definedness";
  }
  return "read";
}

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      read: "Computed read can return an inherited Object member. Use ownEntry(table, key), an Object.hasOwn guard, a Map, or a null-prototype table.",
      truthy:
        "Truthy test can pass on an inherited Object member. For membership use Object.hasOwn(table, key); for a truthy own value use ownEntry(table, key).",
      definedness:
        "Definedness test can see an inherited Object member. Test ownEntry(table, key) for definedness or use Object.hasOwn(table, key) for membership.",
      destructure:
        "Computed destructuring can bind an inherited Object member. Bind the value with ownEntry(table, key).",
      membership:
        "The in test includes inherited Object members. Use Object.hasOwn(table, key) or Map.has(key).",
      write:
        "Computed write can reach an inherited Object member. For construction use Object.fromEntries, a Map, or a null-prototype table. For an existing table define an own data property with Object.defineProperty.",
      update:
        "Computed update can read or write an inherited Object member. Use a Map or a null-prototype table, or read with ownEntry and define an own data property with Object.defineProperty after handling absence.",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program) return {};
    const program = services.program;
    const checker = program.getTypeChecker();
    const symbol = (node) => checker.getSymbolAtLocation(node);
    const typeOf = (node) => checker.getTypeAtLocation(node);
    const parts = (type) => (type.isUnion() ? type.types : [type]);
    const writesByFile = new Map();

    function namedMember(node) {
      if (ts.isPropertyAccessExpression(node)) return node.name.text;
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
        return node.argumentExpression.text;
      return undefined;
    }

    function sameValue(left, right) {
      left = unwrapLookup(left);
      right = unwrapLookup(right);
      if (left === right) return true;
      const name = namedMember(left);
      if (name !== undefined && name === namedMember(right))
        return sameValue(left.expression, right.expression);
      if (left.kind !== right.kind) return false;
      if (ts.isIdentifier(left))
        return left.text === right.text && Boolean(symbol(left)) && symbol(left) === symbol(right);
      if (left.kind === ts.SyntaxKind.ThisKeyword) return true;
      if (ts.isElementAccessExpression(left))
        return (
          sameValue(left.expression, right.expression) &&
          sameValue(left.argumentExpression, right.argumentExpression)
        );
      return ts.isLiteralExpression(left) && left.text === right.text;
    }

    function defaultLibrarySymbol(node, name) {
      return (
        ts.isIdentifier(node) &&
        node.text === name &&
        symbol(node)?.declarations?.some((declaration) =>
          program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
        )
      );
    }

    function objectMethod(node, name) {
      return (
        ts.isCallExpression(node) &&
        !node.questionDotToken &&
        ts.isPropertyAccessExpression(node.expression) &&
        !node.expression.questionDotToken &&
        node.expression.name.text === name &&
        defaultLibrarySymbol(node.expression.expression, "Object")
      );
    }

    function hasOwnCall(node) {
      if (objectMethod(node, "hasOwn")) return true;
      if (!ts.isCallExpression(node) || node.questionDotToken) return false;
      const method = node.expression;
      if (
        !ts.isPropertyAccessExpression(method) ||
        method.questionDotToken ||
        method.name.text !== "call"
      )
        return false;
      const own = method.expression;
      if (
        !ts.isPropertyAccessExpression(own) ||
        own.questionDotToken ||
        own.name.text !== "hasOwnProperty"
      )
        return false;
      const prototype = own.expression;
      return (
        ts.isPropertyAccessExpression(prototype) &&
        !prototype.questionDotToken &&
        prototype.name.text === "prototype" &&
        defaultLibrarySymbol(prototype.expression, "Object")
      );
    }

    function mutationSites(file) {
      if (writesByFile.has(file)) return writesByFile.get(file);
      const writes = [];
      const visit = (node) => {
        if (
          (ts.isIdentifier(node) ||
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)) &&
          (ts.isWriteAccess(node) || ts.isDeleteExpression(node.parent))
        )
          writes.push({ target: node, effect: node.parent });
        if (objectMethod(node, "setPrototypeOf") && node.arguments.length === 2)
          writes.push({ target: node.arguments[0], effect: node });
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ["add", "push", "unshift", "splice", "fill", "copyWithin"].includes(
            node.expression.name.text,
          )
        )
          writes.push({ target: node.expression.expression, effect: node, enumerationOnly: true });
        ts.forEachChild(node, visit);
      };
      visit(file);
      writesByFile.set(file, writes);
      return writes;
    }

    function affects(target, expression, key) {
      expression = unwrapLookup(expression);
      if (sameValue(target, expression)) return true;
      if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
        if (affects(target, expression.expression)) return true;
        if (
          ts.isElementAccessExpression(expression) &&
          affects(target, expression.argumentExpression)
        )
          return true;
      }
      target = unwrapLookup(target);
      return (
        ((ts.isElementAccessExpression(target) &&
          sameValue(target.expression, expression) &&
          (!key || sameValue(target.argumentExpression, key))) ||
          (ts.isPropertyAccessExpression(target) &&
            sameValue(target.expression, expression) &&
            (!key ||
              parts(typeOf(key)).some((part) =>
                checker.isTypeAssignableTo(checker.getStringLiteralType(target.name.text), part),
              )))) &&
        ts.isDeleteExpression(target.parent)
      );
    }

    function rejectedBranch(start, use) {
      for (let child = start; child.parent; child = child.parent) {
        const parent = child.parent;
        if (ts.isFunctionLike(parent)) break;
        if (ts.isConditionalExpression(parent) || ts.isIfStatement(parent)) {
          const condition = parent.condition ?? parent.expression;
          if (child !== condition) continue;
          const yes = parent.whenTrue ?? parent.thenStatement;
          const no = parent.whenFalse ?? parent.elseStatement;
          if (use.pos >= yes.pos && use.end <= yes.end) return no;
          if (no && use.pos >= no.pos && use.end <= no.end) return yes;
          if (ts.isIfStatement(parent) && parent.end <= use.getStart()) {
            if (exitsLookupBranch(yes, use)) return yes;
            if (no && exitsLookupBranch(no, use)) return no;
          }
        }
      }
      return undefined;
    }

    function stable(start, use, table, key, enumerated = false) {
      if (start.getSourceFile() !== use.getSourceFile()) return false;
      let last = use.end;
      for (let parent = use.parent; parent && !ts.isFunctionLike(parent); parent = parent.parent) {
        if (ts.isIterationStatement(parent, false) && start.end <= parent.getStart())
          last = parent.end + 1;
      }
      const rejected = last === use.end ? rejectedBranch(start, use) : undefined;
      return !mutationSites(use.getSourceFile()).some(
        ({ target, effect, enumerationOnly }) =>
          (!enumerationOnly || enumerated) &&
          effect !== start &&
          target.pos >= start.end &&
          effect.end < last &&
          (!rejected || target.pos < rejected.pos || target.end > rejected.end) &&
          (affects(target, table, key) ||
            (key && affects(target, key)) ||
            (enumerated &&
              ts.isElementAccessExpression(target) &&
              sameValue(target.expression, table))),
      );
    }

    function stableDeclaration(declaration, use, expression) {
      const file = declaration.getSourceFile();
      if (file === use.getSourceFile()) return stable(declaration, use, expression);
      const binding = symbol(declaration.name);
      return (
        !mutationSites(file).some(({ target }) => symbol(target) === binding) &&
        !mutationSites(use.getSourceFile()).some(
          ({ target, effect }) => effect.end < use.end && affects(target, expression),
        )
      );
    }

    function proves(condition, truthy, accept) {
      condition = unwrapLookup(condition);
      if (
        ts.isPrefixUnaryExpression(condition) &&
        condition.operator === ts.SyntaxKind.ExclamationToken
      )
        return proves(condition.operand, !truthy, accept);
      if (ts.isBinaryExpression(condition)) {
        const operator = condition.operatorToken.kind;
        const and = operator === ts.SyntaxKind.AmpersandAmpersandToken;
        if (and || operator === ts.SyntaxKind.BarBarToken) {
          const left = proves(condition.left, truthy, accept);
          return and === truthy
            ? left || proves(condition.right, truthy, accept)
            : left && proves(condition.right, truthy, accept);
        }
      }
      return accept(condition, truthy);
    }

    function protectedLookup(use, accept) {
      for (let child = use; child.parent; child = child.parent) {
        const parent = child.parent;
        if (ts.isFunctionLike(parent)) break;
        if (ts.isIfStatement(parent) || ts.isConditionalExpression(parent)) {
          const yes = ts.isIfStatement(parent) ? parent.thenStatement : parent.whenTrue;
          const no = ts.isIfStatement(parent) ? parent.elseStatement : parent.whenFalse;
          if (
            (child === yes || child === no) &&
            proves(parent.expression ?? parent.condition, child === yes, accept)
          )
            return true;
        }
        if (ts.isBinaryExpression(parent) && child === parent.right) {
          const operator = parent.operatorToken.kind;
          if (
            operator === ts.SyntaxKind.AmpersandAmpersandToken &&
            proves(parent.left, true, accept)
          )
            return true;
          if (operator === ts.SyntaxKind.BarBarToken && proves(parent.left, false, accept))
            return true;
        }
        if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
          for (const statement of parent.statements) {
            if (statement === child) break;
            if (ts.isIfStatement(statement)) {
              if (
                exitsLookupBranch(statement.thenStatement, use) &&
                proves(statement.expression, false, accept)
              )
                return true;
              if (
                statement.elseStatement &&
                exitsLookupBranch(statement.elseStatement, use) &&
                proves(statement.expression, true, accept)
              )
                return true;
            } else if (ts.isExpressionStatement(statement) && accept(statement.expression, true)) {
              return true;
            }
          }
        }
      }
      return false;
    }

    function valueDeclaration(expression) {
      let binding = symbol(expression);
      if (binding?.flags & ts.SymbolFlags.Alias) binding = checker.getAliasedSymbol(binding);
      return binding?.valueDeclaration;
    }

    function functionScope(node) {
      while (node.parent && !ts.isFunctionLike(node)) node = node.parent;
      return node;
    }

    function ownGuard(candidate) {
      if (hasOwnCall(candidate)) return candidate;
      if (!ts.isIdentifier(candidate)) return undefined;
      const declaration = valueDeclaration(candidate);
      if (
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        !(declaration.parent.flags & ts.NodeFlags.Const) ||
        !declaration.initializer ||
        declaration.end > candidate.getStart() ||
        functionScope(declaration) !== functionScope(candidate)
      )
        return undefined;
      const call = unwrapLookup(declaration.initializer);
      return hasOwnCall(call) ? call : undefined;
    }

    function nullTable(use, expression, seen = new Set()) {
      expression = unwrapLookup(expression);
      if (seen.has(expression)) return false;
      seen.add(expression);
      if (
        (objectMethod(expression, "create") &&
          expression.arguments[0]?.kind === ts.SyntaxKind.NullKeyword) ||
        objectMethod(expression, "groupBy")
      )
        return true;
      if (ts.isObjectLiteralExpression(expression))
        return expression.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
            property.name.text === "__proto__" &&
            unwrapLookup(property.initializer).kind === ts.SyntaxKind.NullKeyword,
        );
      if (ts.isCallExpression(expression)) {
        const values = lookupReturns(checker.getResolvedSignature(expression)?.declaration);
        return (
          values.length > 0 &&
          values.every((value) => value && nullTable(value, value, new Set(seen)))
        );
      }
      if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return false;
      const declaration = valueDeclaration(expression);
      if (!declaration?.initializer || ts.isParameter(declaration)) return false;
      if (nullTable(declaration, declaration.initializer, seen))
        return stableDeclaration(declaration, use, expression);
      if (!ts.isVariableDeclaration(declaration)) return false;
      const statement = declaration.parent.parent;
      const block = statement.parent;
      if (!ts.isVariableStatement(statement) || (!ts.isBlock(block) && !ts.isSourceFile(block)))
        return false;
      const next = block.statements[block.statements.indexOf(statement) + 1];
      if (!next || !ts.isExpressionStatement(next)) return false;
      const call = next.expression;
      return (
        next.end <= use.getStart() &&
        objectMethod(call, "setPrototypeOf") &&
        call.arguments.length === 2 &&
        sameValue(call.arguments[0], declaration.name) &&
        call.arguments[1].kind === ts.SyntaxKind.NullKeyword &&
        stable(next, use, expression)
      );
    }

    function enumeration(source, method, table, use, seen = new Set()) {
      source = unwrapLookup(source);
      if (seen.has(source)) return false;
      seen.add(source);
      if (objectMethod(source, method))
        return (
          source.arguments.length === 1 &&
          sameValue(source.arguments[0], table) &&
          stable(source, use, table)
        );
      if (ts.isIdentifier(source)) {
        const declaration = valueDeclaration(source);
        return (
          declaration &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          declaration.parent.flags & ts.NodeFlags.Const &&
          stable(declaration, use, source, undefined, true) &&
          enumeration(declaration.initializer, method, table, use, seen)
        );
      }
      if (
        ts.isArrayLiteralExpression(source) &&
        source.elements.length === 1 &&
        ts.isSpreadElement(source.elements[0])
      )
        return enumeration(source.elements[0].expression, method, table, use, seen);
      if (
        ts.isNewExpression(source) &&
        defaultLibrarySymbol(source.expression, "Set") &&
        source.arguments?.length === 1
      )
        return enumeration(source.arguments[0], method, table, use, seen);
      if (
        ts.isCallExpression(source) &&
        ts.isPropertyAccessExpression(source.expression) &&
        ["filter", "slice", "sort", "toSorted"].includes(source.expression.name.text)
      )
        return enumeration(source.expression.expression, method, table, use, seen);
      return false;
    }

    function enumeratedKey(key, table, use, seen = new Set()) {
      key = unwrapLookup(key);
      if (seen.has(key)) return false;
      seen.add(key);
      let method = "keys";
      let entry = key;
      if (ts.isElementAccessExpression(key)) {
        if (enumeration(key.expression, method, table, use)) return true;
        const index = unwrapLookup(key.argumentExpression);
        if (!ts.isNumericLiteral(index) || index.text !== "0") return false;
        method = "entries";
        entry = unwrapLookup(key.expression);
        if (ts.isElementAccessExpression(entry))
          return enumeration(entry.expression, method, table, use);
      }
      let binding = valueDeclaration(entry);
      if (!binding) return false;
      if (ts.isBindingElement(binding)) {
        const pattern = binding.parent;
        if (
          method === "entries" ||
          !ts.isArrayBindingPattern(pattern) ||
          pattern.elements[0] !== binding ||
          binding.dotDotDotToken ||
          binding.initializer
        )
          return false;
        binding = pattern.parent;
        method = "entries";
      }
      if (ts.isVariableDeclaration(binding)) {
        if (
          method === "keys" &&
          binding.initializer &&
          binding.parent.flags & ts.NodeFlags.Const &&
          stable(binding, use, key)
        ) {
          return enumeratedKey(binding.initializer, table, use, seen);
        }
        const loop = binding.parent.parent;
        return (
          ts.isForOfStatement(loop) &&
          use.pos >= loop.statement.pos &&
          use.end <= loop.statement.end &&
          stable(binding, use, key) &&
          enumeration(loop.expression, method, table, use)
        );
      }
      if (!ts.isParameter(binding)) return false;
      const callback = binding.parent;
      const call = callback.parent;
      if (
        !ts.isCallExpression(call) ||
        call.arguments[0] !== callback ||
        !ts.isPropertyAccessExpression(call.expression)
      )
        return false;
      const name = call.expression.name.text;
      const index = name === "reduce" || name === "reduceRight" ? 1 : 0;
      return (
        (index === 1 || keyCallbacks.has(name)) &&
        callback.parameters[index] === binding &&
        stable(binding, use, key) &&
        enumeration(call.expression.expression, method, table, use)
      );
    }

    function keyCandidates(key) {
      key = unwrapLookup(key);
      const declaration =
        ts.isIdentifier(key) || ts.isPropertyAccessExpression(key)
          ? valueDeclaration(key)
          : undefined;
      const declared = declaration?.type
        ? checker.getTypeFromTypeNode(declaration.type)
        : declaration?.name
          ? checker.getTypeOfSymbolAtLocation(symbol(declaration.name) ?? symbol(key), declaration)
          : typeOf(key);
      const type = checker.getBaseConstraintOfType(declared) ?? declared;
      if (
        parts(type).some(
          (part) =>
            part.flags &
            (ts.TypeFlags.String |
              ts.TypeFlags.Any |
              ts.TypeFlags.Unknown |
              ts.TypeFlags.TemplateLiteral |
              ts.TypeFlags.StringMapping),
        )
      )
        return inheritedNames;
      return new Set(
        parts(type)
          .filter((part) => part.isStringLiteral() && inheritedNames.has(part.value))
          .map((part) => part.value),
      );
    }

    function plainTable(type) {
      if (type.isIntersection()) return type.types.every(plainTable);
      if (
        !(type.flags & ts.TypeFlags.Object) ||
        checker.isArrayType(type) ||
        checker.isTupleType(type) ||
        type.isClass() ||
        type.getCallSignatures().length ||
        type.getConstructSignatures().length
      )
        return false;
      const target = type.target ?? type;
      if (target.isClass() || checker.getIndexInfoOfType(type, ts.IndexKind.Number)) return false;
      return !target
        .getSymbol()
        ?.declarations?.some(
          (declaration) =>
            (ts.isInterfaceDeclaration(declaration) || ts.isClassLike(declaration)) &&
            program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
        );
    }

    function ownLiteralName(table, name, use) {
      const expression = unwrapLookup(table);
      const declaration = valueDeclaration(expression);
      const source = declaration?.initializer ? unwrapLookup(declaration.initializer) : expression;
      return (
        ts.isObjectLiteralExpression(source) &&
        (source === expression || stableDeclaration(declaration, use, expression)) &&
        source.properties.some((property) => {
          const key = property.name;
          return (
            key &&
            (ts.isIdentifier(key) || ts.isStringLiteralLike(key)
              ? key.text === name
              : ts.isComputedPropertyName(key) &&
                ts.isStringLiteralLike(key.expression) &&
                key.expression.text === name) &&
            (name !== "__proto__" ||
              !ts.isPropertyAssignment(property) ||
              ts.isComputedPropertyName(key))
          );
        })
      );
    }

    function keyGuard(guard, truthy, use, table, key, form, candidates) {
      if (
        truthy &&
        ts.isCallExpression(guard) &&
        ts.isPropertyAccessExpression(guard.expression) &&
        !guard.questionDotToken &&
        !guard.expression.questionDotToken &&
        guard.arguments.length === 1
      ) {
        const { expression: receiver, name } = guard.expression;
        const [argument] = guard.arguments;
        if (
          name.text === "includes" &&
          sameValue(argument, key) &&
          enumeration(receiver, "keys", table, use)
        )
          return true;
        if (
          sameValue(receiver, key) &&
          ts.isStringLiteralLike(argument) &&
          checker.isTypeAssignableTo(typeOf(receiver), checker.getStringType())
        ) {
          if (name.text === "startsWith")
            return [...candidates].every((candidate) => !candidate.startsWith(argument.text));
          if (name.text === "endsWith")
            return [...candidates].every((candidate) => !candidate.endsWith(argument.text));
        }
      }
      if (!ts.isBinaryExpression(guard)) return false;
      const other = sameValue(guard.left, key)
        ? guard.right
        : sameValue(guard.right, key)
          ? guard.left
          : undefined;
      if (!other || !ts.isStringLiteralLike(other)) return false;
      const comparison = guard.operatorToken.kind;
      if (
        comparison ===
        (truthy
          ? ts.SyntaxKind.EqualsEqualsEqualsToken
          : ts.SyntaxKind.ExclamationEqualsEqualsToken)
      )
        return !candidates.has(other.text);
      return (
        form === "write" &&
        other.text === "__proto__" &&
        comparison ===
          (truthy
            ? ts.SyntaxKind.ExclamationEqualsEqualsToken
            : ts.SyntaxKind.EqualsEqualsEqualsToken)
      );
    }

    function checkLookup(node, use, table, key, form) {
      const candidates = keyCandidates(key);
      if (!candidates.size) return;
      const target = checker.getNonNullableType(typeOf(table));
      if (
        !parts(target).every(plainTable) ||
        [...candidates].every((name) => ownLiteralName(table, name, use)) ||
        nullTable(use, table) ||
        enumeratedKey(key, table, use)
      )
        return;
      if (
        protectedLookup(use, (guard, truthy) => {
          const own =
            truthy && !ts.isExpressionStatement(guard.parent) ? ownGuard(guard) : undefined;
          if (
            own?.arguments.length === 2 &&
            sameValue(own.arguments[0], table) &&
            sameValue(own.arguments[1], key) &&
            stable(own, use, table, key)
          )
            return true;
          if (
            truthy &&
            objectMethod(guard, "setPrototypeOf") &&
            ts.isExpressionStatement(guard.parent) &&
            guard.arguments.length === 2 &&
            sameValue(guard.arguments[0], table) &&
            guard.arguments[1].kind === ts.SyntaxKind.NullKeyword &&
            stable(guard, use, table, key)
          )
            return true;
          return (
            keyGuard(guard, truthy, use, table, key, form, candidates) &&
            stable(guard, use, table, key)
          );
        })
      )
        return;
      context.report({ node, messageId: form });
    }

    const tsNode = (node) => services.esTreeNodeToTSNodeMap.get(node);
    return {
      MemberExpression(node) {
        if (!node.computed) return;
        const expression = tsNode(node);
        let target = expression;
        while (ts.isParenthesizedExpression(target.parent)) target = target.parent;
        if (ts.isDeleteExpression(target.parent)) return;
        checkLookup(
          node,
          expression,
          expression.expression,
          expression.argumentExpression,
          lookupWrite(expression) ?? lookupTest(expression),
        );
      },
      BinaryExpression(node) {
        if (node.operator !== "in") return;
        const expression = tsNode(node);
        if (!ts.isPrivateIdentifier(expression.left))
          checkLookup(node, expression, expression.right, expression.left, "membership");
      },
      Property(node) {
        if (!node.computed || node.parent.type !== "ObjectPattern") return;
        const property = tsNode(node);
        const pattern = property.parent;
        const declaration = pattern.parent;
        let table = ts.isVariableDeclaration(declaration)
          ? (declaration.initializer ?? pattern)
          : pattern;
        if (
          ts.isObjectLiteralExpression(pattern) &&
          ts.isBinaryExpression(declaration) &&
          declaration.left === pattern &&
          declaration.operatorToken.kind === ts.SyntaxKind.EqualsToken
        )
          table = declaration.right;
        const key = property.propertyName ?? property.name;
        if (table && key && ts.isComputedPropertyName(key))
          checkLookup(node, property, table, key.expression, "destructure");
      },
    };
  },
};
