import ts from "typescript";

const inheritedNames = Object.getOwnPropertyNames(Object.prototype);

function unwrap(node) {
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

function declaringConst(symbol) {
  const declaration = symbol?.valueDeclaration;
  return declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.parent.flags & ts.NodeFlags.Const
    ? declaration
    : undefined;
}

function exits(statement) {
  return (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    (ts.isContinueStatement(statement) && !statement.label) ||
    (ts.isBlock(statement) && statement.statements.length > 0 && exits(statement.statements.at(-1)))
  );
}

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      read: "A data key can read an inherited Object member. Check Object.hasOwn or use a Map or a null-prototype table.",
      membership:
        "Use Object.hasOwn to test table membership. The in operator includes inherited members.",
      write:
        "A data key can invoke the inherited __proto__ setter. Build the table with Object.fromEntries, a Map, or a null prototype.",
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

    function sameValue(left, right) {
      left = unwrap(left);
      right = unwrap(right);
      if (ts.isIdentifier(left) && ts.isIdentifier(right))
        return left.text === right.text && symbol(left) === symbol(right);
      if (ts.isPropertyAccessExpression(left) && ts.isPropertyAccessExpression(right))
        return left.name.text === right.name.text && sameValue(left.expression, right.expression);
      return ts.isLiteralExpression(left) && left.kind === right.kind && left.text === right.text;
    }

    function objectCall(node, name) {
      return (
        ts.isCallExpression(node) &&
        !node.questionDotToken &&
        ts.isPropertyAccessExpression(node.expression) &&
        !node.expression.questionDotToken &&
        node.expression.name.text === name &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Object" &&
        symbol(node.expression.expression)?.declarations?.some((declaration) =>
          program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
        )
      );
    }

    function proves(condition, truthy, accept) {
      condition = unwrap(condition);
      if (
        ts.isPrefixUnaryExpression(condition) &&
        condition.operator === ts.SyntaxKind.ExclamationToken
      )
        return proves(condition.operand, !truthy, accept);
      if (ts.isBinaryExpression(condition)) {
        const sufficient = truthy
          ? ts.SyntaxKind.AmpersandAmpersandToken
          : ts.SyntaxKind.BarBarToken;
        if (condition.operatorToken.kind === sufficient)
          return proves(condition.left, truthy, accept) || proves(condition.right, truthy, accept);
      }
      return truthy && accept(condition);
    }

    function protectedBy(node, accept) {
      for (let child = node; child.parent; child = child.parent) {
        const parent = child.parent;
        if (ts.isFunctionLike(parent)) break;
        if (ts.isIfStatement(parent) || ts.isConditionalExpression(parent)) {
          const then = ts.isIfStatement(parent) ? parent.thenStatement : parent.whenTrue;
          const otherwise = ts.isIfStatement(parent) ? parent.elseStatement : parent.whenFalse;
          if (
            (child === then || child === otherwise) &&
            proves(parent.expression ?? parent.condition, child === then, accept)
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
          const previous = parent.statements[parent.statements.indexOf(child) - 1];
          if (
            previous &&
            ts.isIfStatement(previous) &&
            !previous.elseStatement &&
            exits(previous.thenStatement) &&
            proves(previous.expression, false, accept)
          )
            return true;
        }
      }
      return false;
    }

    function returnValues(factory) {
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

    function nullTable(node, expression, factories = new Set()) {
      expression = unwrap(expression);
      const declaration = ts.isIdentifier(expression)
        ? declaringConst(symbol(expression))
        : undefined;
      const source = declaration?.initializer ? unwrap(declaration.initializer) : expression;
      if (objectCall(source, "create") && source.arguments[0]?.kind === ts.SyntaxKind.NullKeyword)
        return true;
      if (
        ts.isObjectLiteralExpression(source) &&
        source.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
            property.name.text === "__proto__" &&
            unwrap(property.initializer).kind === ts.SyntaxKind.NullKeyword,
        )
      )
        return true;
      if (ts.isCallExpression(source)) {
        const factory = checker.getResolvedSignature(source)?.declaration;
        if (!factory?.body || factories.has(factory)) return false;
        factories.add(factory);
        const values = returnValues(factory);
        return (
          values.length > 0 &&
          values.every((value) => value && nullTable(value, value, new Set(factories)))
        );
      }
      if (!declaration) return false;
      const statement = declaration.parent.parent;
      if (!ts.isVariableStatement(statement)) return false;
      const block = statement.parent;
      if (!ts.isBlock(block) && !ts.isSourceFile(block)) return false;
      const next = block.statements[block.statements.indexOf(statement) + 1];
      return (
        next &&
        ts.isExpressionStatement(next) &&
        next.end <= node.getStart() &&
        objectCall(next.expression, "setPrototypeOf") &&
        next.expression.arguments.length === 2 &&
        sameValue(next.expression.arguments[0], expression) &&
        next.expression.arguments[1].kind === ts.SyntaxKind.NullKeyword
      );
    }

    function declaredKey(type, target) {
      return parts(type).every(
        (part) =>
          (part.isStringLiteral() || part.isNumberLiteral()) &&
          checker.getPropertyOfType(target, String(part.value)),
      );
    }

    function couldName(type, names) {
      type = checker.getBaseConstraintOfType(type) ?? type;
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
      return names.some((name) =>
        checker.isTypeAssignableTo(checker.getStringLiteralType(name), type),
      );
    }

    function literalProperty(object, name) {
      if (!ts.isObjectLiteralExpression(object)) return undefined;
      const property = object.properties.find(
        (entry) =>
          ts.isPropertyAssignment(entry) &&
          (ts.isIdentifier(entry.name) || ts.isStringLiteralLike(entry.name)) &&
          entry.name.text === name,
      );
      return property && unwrap(property.initializer);
    }

    function initializer(node) {
      if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return undefined;
      let target = symbol(node);
      if (target?.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
      const property = target?.valueDeclaration;
      const declaration =
        property && ts.isPropertyAssignment(property) ? property : declaringConst(target);
      if (declaration?.initializer) return unwrap(declaration.initializer);
      if (ts.isPropertyAccessExpression(node)) {
        const base = unwrap(node.expression);
        return literalProperty(initializer(base) ?? base, node.name.text);
      }
      return undefined;
    }

    const referencesByFile = new Map();
    function referenceSites(node) {
      const file = node.getSourceFile();
      let usages = referencesByFile.get(file);
      if (!usages) {
        usages = new Map();
        referencesByFile.set(file, usages);
        const visit = (child) => {
          if (ts.isIdentifier(child)) {
            const reference = ts.isExportSpecifier(child.parent)
              ? checker.getExportSpecifierLocalTargetSymbol(child.parent)
              : symbol(child);
            if (reference) {
              if (!usages.has(reference)) usages.set(reference, []);
              usages.get(reference).push(child);
            }
          }
          ts.forEachChild(child, visit);
        };
        visit(file);
      }
      return usages.get(symbol(node)) ?? [];
    }

    function regexPattern(node) {
      if (!node) return undefined;
      node = unwrap(node);
      node = initializer(node) ?? node;
      if (ts.isRegularExpressionLiteral(node)) return /^\/(.*)\/([a-z]*)$/s.exec(node.text);
      if (
        !ts.isNewExpression(node) ||
        !ts.isIdentifier(node.expression) ||
        node.expression.text !== "RegExp" ||
        !symbol(node.expression)?.declarations?.some((declaration) =>
          program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
        )
      )
        return undefined;
      const [source, flags] = node.arguments ?? [];
      if (!source || (flags && !ts.isStringLiteralLike(flags))) return undefined;
      if (ts.isStringLiteralLike(source)) return ["", source.text, flags?.text ?? ""];
      if (!ts.isTemplateExpression(source)) return undefined;
      let pattern = source.head.text;
      for (const span of source.templateSpans) {
        const joined = unwrap(span.expression);
        if (
          !ts.isCallExpression(joined) ||
          !ts.isPropertyAccessExpression(joined.expression) ||
          joined.expression.name.text !== "join" ||
          joined.arguments.length !== 1 ||
          !ts.isStringLiteralLike(joined.arguments[0])
        )
          return undefined;
        const names = enumeratedNames(joined.expression.expression, "keys");
        if (!names) return undefined;
        pattern += names.join(joined.arguments[0].text) + span.literal.text;
      }
      return ["", pattern, flags?.text ?? ""];
    }

    function matchesName(regex, names, group = 0) {
      const [, pattern, flags] = regex;
      // Assertions can match a spelling inside a larger string. Keep that possibility.
      if (/\(\?[<!=]|\\[bB1-9]/.test(pattern)) return true;
      const simple = String.raw`(?:\\.|\[(?:\\.|[^\]\\])+\]|[^()\[\\])`;
      const capture = String.raw`\((?!\?)(${simple}*)\)`;
      const prefix = `(?:${simple}*${capture})`;
      const body =
        group === 0
          ? pattern
          : group <= 4
            ? new RegExp(`^${prefix}{${group}}`).exec(pattern)?.[1]
            : undefined;
      if (body === undefined) return true;
      try {
        const whole = new RegExp(`^(?:${body})$`, flags.replace(/[gy]/g, ""));
        return names.some((name) => whole.test(name));
      } catch {
        return true;
      }
    }

    function capturesFrom(node, names, group) {
      node = unwrap(node);
      node = initializer(node) ?? node;
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression))
        return true;
      const { expression, name } = node.expression;
      if (name.text === "exec" && regexPattern(expression))
        return matchesName(regexPattern(expression), names, group);
      if (
        ["match", "matchAll"].includes(name.text) &&
        typeOf(expression).flags & ts.TypeFlags.StringLike
      ) {
        const regex = regexPattern(node.arguments[0]);
        if (regex && (name.text === "matchAll" || !regex[2].includes("g")))
          return matchesName(regex, names, group);
      }
      return true;
    }

    function iteration(node) {
      const declaration = symbol(node)?.valueDeclaration;
      if (!declaration) return undefined;
      if (ts.isVariableDeclaration(declaration) && ts.isForOfStatement(declaration.parent.parent))
        return [declaration.parent.parent.expression, declaration];
      if (!ts.isParameter(declaration) || declaration.parent.parameters[0] !== declaration)
        return undefined;
      const callback = declaration.parent;
      const call = callback.parent;
      if (
        ts.isCallExpression(call) &&
        call.arguments[0] === callback &&
        ts.isPropertyAccessExpression(call.expression) &&
        ["every", "filter", "find", "flatMap", "forEach", "map", "some"].includes(
          call.expression.name.text,
        )
      )
        return [call.expression.expression, declaration];
      return undefined;
    }

    function enumeratedNames(source, method) {
      source = unwrap(source);
      source = initializer(source) ?? source;
      if (objectCall(source, method) && source.arguments.length === 1) {
        const target = unwrap(source.arguments[0]);
        const table = initializer(target) ?? target;
        if (!ts.isObjectLiteralExpression(table)) return undefined;
        if (ts.isIdentifier(target)) {
          const variable = symbol(target);
          const definition =
            variable?.flags & ts.SymbolFlags.Alias
              ? checker.getAliasedSymbol(variable).valueDeclaration
              : variable?.valueDeclaration;
          const writes = (binding) =>
            referenceSites(binding).some((site) => {
              const parent = site.parent;
              if (ts.isPropertyAccessExpression(parent) && parent.expression === site)
                return ts.isWriteAccess(parent) || ts.isDeleteExpression(parent.parent);
              return (
                ts.isElementAccessExpression(parent) &&
                parent.expression === site &&
                (ts.isWriteAccess(parent) || ts.isDeleteExpression(parent.parent))
              );
            });
          if (
            writes(target) ||
            (definition &&
              ts.isVariableDeclaration(definition) &&
              ts.isIdentifier(definition.name) &&
              writes(definition.name))
          )
            return undefined;
        }
        const names = [];
        for (const property of table.properties) {
          const key = property.name;
          if (
            !key ||
            !(ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))
          )
            return undefined;
          names.push(key.text);
        }
        return names;
      }
      if (
        ts.isCallExpression(source) &&
        ts.isPropertyAccessExpression(source.expression) &&
        ["filter", "slice", "sort", "toSorted"].includes(source.expression.name.text)
      )
        return enumeratedNames(source.expression.expression, method);
      return undefined;
    }

    function projectedValue(value, property) {
      if (typeof property === "number")
        return ts.isArrayLiteralExpression(value) && value.elements[property];
      return literalProperty(value, property);
    }

    function sequenceCouldName(source, names, seen, property) {
      source = unwrap(source);
      if (seen.has(source)) return true;
      seen.add(source);
      if (ts.isArrayLiteralExpression(source))
        return source.elements.some((item) => {
          if (ts.isSpreadElement(item))
            return sequenceCouldName(item.expression, names, new Set(seen), property);
          item = unwrap(item);
          if (property === undefined) return keyCouldName(item, names, new Set(seen));
          const value = projectedValue(initializer(item) ?? item, property);
          return !value || keyCouldName(value, names, new Set(seen));
        });
      if (ts.isIdentifier(source)) {
        const initial = initializer(source);
        // Array elements can be written even through a const. Track only direct reads.
        if (
          !initial ||
          referenceSites(source).some((site) => {
            const parent = site.parent;
            if (
              (ts.isVariableDeclaration(parent) && parent.name === site) ||
              ts.isImportSpecifier(parent) ||
              ts.isImportClause(parent)
            )
              return false;
            if (ts.isForOfStatement(parent) && parent.expression === site) return false;
            if (ts.isSpreadElement(parent) && ts.isArrayLiteralExpression(parent.parent))
              return false;
            if (
              ts.isCallExpression(parent) &&
              parent.arguments[0] === site &&
              ts.isPropertyAccessExpression(parent.expression) &&
              parent.expression.name.text === "each"
            )
              return false;
            return (
              !ts.isPropertyAccessExpression(parent) ||
              ![
                "every",
                "filter",
                "find",
                "flatMap",
                "forEach",
                "includes",
                "length",
                "map",
                "some",
                "toSorted",
                "slice",
              ].includes(parent.name.text)
            );
          })
        )
          return true;
        return sequenceCouldName(initial, names, seen, property);
      }
      if (!ts.isCallExpression(source)) return true;
      const keys = enumeratedNames(source, "keys");
      if (keys) return property !== undefined || keys.some((key) => names.includes(key));
      if (ts.isPropertyAccessExpression(source.expression)) {
        const { expression, name } = source.expression;
        if (["filter", "slice", "toSorted"].includes(name.text))
          return sequenceCouldName(expression, names, seen, property);
        if (name.text === "map" || name.text === "flatMap") {
          const mapper = source.arguments[0];
          if (!mapper || !ts.isArrowFunction(mapper) || ts.isBlock(mapper.body)) return true;
          const result = unwrap(mapper.body);
          if (name.text === "flatMap")
            return sequenceCouldName(result, names, new Set(seen), property);
          if (property !== undefined) {
            const value = projectedValue(result, property);
            return !value || keyCouldName(value, names, new Set(seen));
          }
          if (
            ts.isPropertyAccessExpression(result) &&
            mapper.parameters.length > 0 &&
            sameValue(mapper.parameters[0].name, result.expression)
          )
            return sequenceCouldName(expression, names, seen, result.name.text);
          const array = unwrap(expression);
          if (
            ts.isElementAccessExpression(result) &&
            mapper.parameters.length > 0 &&
            sameValue(mapper.parameters[0].name, result.expression) &&
            ts.isNumericLiteral(result.argumentExpression) &&
            ts.isArrayLiteralExpression(array) &&
            array.elements.length === 1 &&
            ts.isSpreadElement(array.elements[0])
          )
            return capturesFrom(
              array.elements[0].expression,
              names,
              Number(result.argumentExpression.text),
            );
          return keyCouldName(result, names, new Set(seen));
        }
      }
      const factory = checker.getResolvedSignature(source)?.declaration;
      const values = returnValues(factory);
      return (
        !values.length ||
        values.some((value) => !value || sequenceCouldName(value, names, new Set(seen)))
      );
    }

    function keyCouldName(key, names, seen = new Set()) {
      key = unwrap(key);
      if (seen.has(key)) return true;
      seen.add(key);
      if (!couldName(typeOf(key), names)) return false;
      const source = initializer(key) ?? key;
      if (ts.isTemplateExpression(source))
        return names.some(
          (name) =>
            name.startsWith(source.head.text) &&
            name.endsWith(source.templateSpans.at(-1).literal.text),
        );
      if (source !== key && !keyCouldName(source, names, seen)) return false;
      if (
        ts.isBinaryExpression(source) &&
        source.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      )
        return (
          keyCouldName(source.left, names, new Set(seen)) ||
          keyCouldName(source.right, names, new Set(seen))
        );
      if (ts.isElementAccessExpression(source)) {
        if (typeOf(source.expression).flags & ts.TypeFlags.StringLike) return false;
        const index = source.argumentExpression;
        if (ts.isNumericLiteral(index))
          return capturesFrom(source.expression, names, Number(index.text));
      }
      if (ts.isPropertyAccessExpression(key)) {
        const source = iteration(key.expression);
        if (source) return sequenceCouldName(source[0], names, seen, key.name.text);
      }
      if (!ts.isIdentifier(key)) return true;
      const loop = iteration(key);
      if (loop) return sequenceCouldName(loop[0], names, seen);
      const binding = symbol(key)?.valueDeclaration;
      if (
        binding &&
        ts.isBindingElement(binding) &&
        ts.isArrayBindingPattern(binding.parent) &&
        !binding.dotDotDotToken
      ) {
        const declaration = binding.parent.parent;
        const group = binding.parent.elements.indexOf(binding);
        if (
          group === 0 &&
          ts.isVariableDeclaration(declaration) &&
          ts.isForOfStatement(declaration.parent.parent)
        ) {
          const source = unwrap(declaration.parent.parent.expression);
          const entries = enumeratedNames(source, "entries");
          if (entries) return entries.some((entry) => names.includes(entry));
          const ordered = initializer(source) ?? source;
          const unmodified =
            !ts.isIdentifier(source) ||
            referenceSites(source).every((site) => {
              const parent = site.parent;
              return (
                (ts.isVariableDeclaration(parent) && parent.name === site) ||
                (ts.isForOfStatement(parent) && parent.expression === site) ||
                (ts.isPropertyAccessExpression(parent) &&
                  parent.expression === site &&
                  ["entries", "get", "has", "keys", "size", "values"].includes(parent.name.text))
              );
            });
          if (
            unmodified &&
            ts.isNewExpression(ordered) &&
            ts.isIdentifier(ordered.expression) &&
            ordered.expression.text === "Map" &&
            ordered.arguments?.length &&
            symbol(ordered.expression)?.declarations?.some((record) =>
              program.isSourceFileDefaultLibrary(record.getSourceFile()),
            )
          )
            return sequenceCouldName(ordered.arguments[0], names, new Set(seen), 0);
        }
        if (ts.isParameter(declaration) && ts.isArrowFunction(declaration.parent)) {
          const call = declaration.parent.parent;
          if (
            ts.isCallExpression(call) &&
            ts.isPropertyAccessExpression(call.expression) &&
            call.expression.name.text === "map" &&
            call.arguments[0] === declaration.parent
          ) {
            const array = unwrap(call.expression.expression);
            if (
              ts.isArrayLiteralExpression(array) &&
              array.elements.length === 1 &&
              ts.isSpreadElement(array.elements[0])
            )
              return capturesFrom(array.elements[0].expression, names, group);
          }
        }
      }
      const parameter = symbol(key)?.valueDeclaration;
      if (!parameter || !ts.isParameter(parameter)) return true;
      const callback = parameter.parent;
      if (ts.isCallExpression(callback.parent) && ts.isCallExpression(callback.parent.expression)) {
        const each = callback.parent.expression;
        if (
          ts.isPropertyAccessExpression(each.expression) &&
          each.expression.name.text === "each" &&
          ts.isIdentifier(each.expression.expression) &&
          symbol(each.expression.expression)?.declarations?.some(
            (declaration) =>
              ts.isImportSpecifier(declaration) &&
              /^(?:vitest|bun:test)$/.test(declaration.parent.parent.parent.moduleSpecifier.text),
          ) &&
          each.arguments.length === 1 &&
          callback.parent.arguments[1] === callback &&
          callback.parameters[0] === parameter
        )
          return sequenceCouldName(each.arguments[0], names, seen);
      }
      const argumentIndex = callback.parameters.indexOf(parameter);
      const owner = ts.isFunctionDeclaration(callback) ? callback : callback.parent;
      if (
        (ts.isFunctionDeclaration(owner) || ts.isVariableDeclaration(owner)) &&
        owner.name &&
        ts.isIdentifier(owner.name)
      ) {
        const statement = ts.isFunctionDeclaration(owner) ? owner : owner.parent.parent;
        if (
          !ts.canHaveModifiers(statement) ||
          ts
            .getModifiers(statement)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
          (ts.isSourceFile(statement.parent) && !ts.isExternalModule(statement.parent))
        )
          return true;
        const uses = referenceSites(owner.name).filter((site) => site !== owner.name);
        return (
          !uses.length ||
          uses.some(
            (site) =>
              !ts.isCallExpression(site.parent) ||
              site.parent.expression !== site ||
              site.parent.arguments.some(ts.isSpreadElement) ||
              !site.parent.arguments[argumentIndex] ||
              keyCouldName(site.parent.arguments[argumentIndex], names, new Set(seen)),
          )
        );
      }
      const call = callback.parent;
      if (
        !ts.isCallExpression(call) ||
        call.arguments[1] !== callback ||
        !ts.isPropertyAccessExpression(call.expression) ||
        !["replace", "replaceAll"].includes(call.expression.name.text) ||
        !(typeOf(call.expression.expression).flags & ts.TypeFlags.StringLike)
      )
        return true;
      const search = call.arguments[0];
      if (search && ts.isStringLiteral(search))
        return argumentIndex === 0 ? names.includes(search.text) : true;
      const regex = regexPattern(search);
      return !regex || matchesName(regex, names, argumentIndex);
    }

    function enumerates(node, method, table, seen = new Set()) {
      node = unwrap(node);
      if (seen.has(node)) return false;
      seen.add(node);
      const source = initializer(node);
      if (source) return enumerates(source, method, table, seen);
      if (objectCall(node, method))
        return node.arguments.length > 0 && sameValue(node.arguments[0], table);
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["filter", "sort", "slice", "toSorted"].includes(node.expression.name.text)
      )
        return enumerates(node.expression.expression, method, table, seen);
      if (!ts.isCallExpression(node)) return false;
      const factory = checker.getResolvedSignature(node)?.declaration;
      if (!factory?.parameters) return false;
      const index = node.arguments.findIndex((argument) => sameValue(argument, table));
      const input = factory.parameters[index];
      const values = returnValues(factory);
      return (
        input &&
        values.length > 0 &&
        values.every((value) => value && enumerates(value, method, input.name, new Set(seen)))
      );
    }

    function forwardsOwnKey(call, callback, binding, table) {
      const factory = checker.getResolvedSignature(call)?.declaration;
      const parameter = factory?.parameters[call.arguments.indexOf(callback)];
      const tableIndex = call.arguments.findIndex((argument) => sameValue(argument, table));
      const input = factory?.parameters[tableIndex]?.name;
      if (!parameter || !input || !ts.isIdentifier(parameter.name)) return false;
      const uses = referenceSites(parameter.name).filter((site) => site !== parameter.name);
      const index = callback.parameters.indexOf(binding);
      return (
        uses.length > 0 &&
        uses.every((site) => {
          const invocation = site.parent;
          if (!ts.isCallExpression(invocation) || invocation.expression !== site) return false;
          const item = invocation.arguments[index];
          const iter = item && iteration(item);
          return iter && enumerates(iter[0], "keys", input);
        })
      );
    }

    function enumeratedKey(key, table) {
      key = unwrap(key);
      if (!ts.isIdentifier(key)) return false;
      const declaration = symbol(key)?.valueDeclaration;
      if (!declaration) return false;
      let binding = declaration;
      let method = "keys";
      if (ts.isBindingElement(binding)) {
        const pattern = binding.parent;
        if (
          !ts.isArrayBindingPattern(pattern) ||
          pattern.elements[0] !== binding ||
          binding.dotDotDotToken
        )
          return false;
        binding = pattern.parent;
        method = "entries";
      }
      if (ts.isVariableDeclaration(binding)) {
        const loop = binding.parent.parent;
        return ts.isForOfStatement(loop) && enumerates(loop.expression, method, table);
      }
      if (!ts.isParameter(binding)) return false;
      const callback = binding.parent;
      const call = callback.parent;
      if (
        method === "keys" &&
        ts.isCallExpression(call) &&
        forwardsOwnKey(call, callback, binding, table)
      )
        return true;
      return (
        binding === callback.parameters[0] &&
        ts.isCallExpression(call) &&
        call.arguments[0] === callback &&
        ts.isPropertyAccessExpression(call.expression) &&
        ["every", "filter", "find", "flatMap", "forEach", "map", "some"].includes(
          call.expression.name.text,
        ) &&
        enumerates(call.expression.expression, method, table)
      );
    }

    function hasReadEvidence(key, table) {
      const source = initializer(key) ?? key;
      if (ts.isCallExpression(source) && ts.isPropertyAccessExpression(source.expression)) {
        const input = unwrap(source.expression.expression);
        if (ts.isElementAccessExpression(input) && initializer(unwrap(input.expression)))
          return false;
      }
      if (!ts.isIdentifier(key)) return true;
      const declaration = symbol(key)?.valueDeclaration;
      if (!declaration || !ts.isBindingElement(declaration)) {
        const iter = iteration(key);
        if (!iter) return true;
        const source = initializer(unwrap(iter[0])) ?? unwrap(iter[0]);
        const collection =
          ts.isCallExpression(source) &&
          ts.isPropertyAccessExpression(source.expression) &&
          source.expression.name.text === "filter"
            ? unwrap(source.expression.expression)
            : source;
        if (objectCall(collection, "keys") && collection.arguments.length === 1) {
          const receiver = unwrap(collection.arguments[0]);
          const initial = initializer(receiver);
          if (initial && ts.isCallExpression(initial) && !nullTable(initial, receiver))
            return false;
        }
        return true;
      }
      const binding = declaration.parent.parent;
      if (ts.isVariableDeclaration(binding)) {
        const loop = binding.parent.parent;
        const literal = initializer(unwrap(table));
        if (
          literal &&
          ts.isObjectLiteralExpression(literal) &&
          literal.getSourceFile() === key.getSourceFile() &&
          ts.isForOfStatement(loop) &&
          objectCall(loop.expression, "entries") &&
          loop.expression.arguments.length === 1
        ) {
          const source = initializer(unwrap(loop.expression.arguments[0]));
          if (source && ts.isObjectLiteralExpression(source) && source.properties.length === 0)
            return false;
        }
      }
      if (!ts.isParameter(binding)) return true;
      const callback = binding.parent;
      const statement = ts.isFunctionDeclaration(callback)
        ? callback
        : ts.isVariableDeclaration(callback.parent)
          ? callback.parent.parent.parent
          : undefined;
      return (
        !statement ||
        ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      );
    }

    function tableType(table, keyType, membership) {
      const target = checker.getNonNullableType(typeOf(table));
      const plain = parts(target).every((part) => {
        const declaration = part.getSymbol()?.declarations?.[0];
        return (
          !checker.isArrayType(part) &&
          !checker.isTupleType(part) &&
          !part.isClass() &&
          !declaration?.getSourceFile().hasNoDefaultLib
        );
      });
      if (!plain) return false;
      if (checker.getIndexInfoOfType(target, ts.IndexKind.String)) return true;
      if (membership) return declaredKey(keyType, target);
      const expression = unwrap(table);
      const declaration = ts.isIdentifier(expression)
        ? declaringConst(symbol(expression))
        : undefined;
      return (
        ts.isObjectLiteralExpression(expression) ||
        (declaration?.initializer && ts.isObjectLiteralExpression(unwrap(declaration.initializer)))
      );
    }

    function check(node, expression, table, key, membership) {
      const bareKey = unwrap(key);
      if (ts.isLiteralExpression(bareKey) || ts.isStringLiteralLike(bareKey)) return;
      const keyType = typeOf(bareKey);
      const parent = expression.parent;
      if (ts.isDeleteExpression(parent)) return;
      const write =
        !membership &&
        ts.isBinaryExpression(parent) &&
        parent.left === expression &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (write && !ts.isIdentifier(unwrap(table)) && !ts.isObjectLiteralExpression(unwrap(table)))
        return;
      const target = checker.getNonNullableType(typeOf(table));
      const closedKey = declaredKey(keyType, target);
      if (!membership && closedKey) return;
      const names = write ? ["__proto__"] : inheritedNames;
      if (!keyCouldName(bareKey, names) && !(membership && closedKey)) return;
      if (!tableType(table, keyType, membership) || nullTable(expression, table)) return;
      if (!write && !membership && !hasReadEvidence(bareKey, table)) return;
      if (!membership && enumeratedKey(key, table)) return;
      if (
        protectedBy(expression, (condition) => {
          if (!membership && objectCall(condition, "hasOwn") && condition.arguments.length === 2)
            return (
              sameValue(condition.arguments[0], table) && sameValue(condition.arguments[1], key)
            );
          if (
            !ts.isCallExpression(condition) ||
            !ts.isPropertyAccessExpression(condition.expression)
          )
            return false;
          const { expression: value, name } = condition.expression;
          const [affix] = condition.arguments;
          if (
            !affix ||
            !ts.isStringLiteralLike(affix) ||
            !sameValue(value, key) ||
            !(typeOf(value).flags & ts.TypeFlags.StringLike) ||
            condition.arguments.length !== 1
          )
            return false;
          if (name.text === "startsWith")
            return names.every((candidate) => !candidate.startsWith(affix.text));
          if (name.text === "endsWith")
            return names.every((candidate) => !candidate.endsWith(affix.text));
          return false;
        })
      )
        return;
      context.report({ node, messageId: membership ? "membership" : write ? "write" : "read" });
    }

    const tsNode = (node) => services.esTreeNodeToTSNodeMap.get(node);
    return {
      MemberExpression(node) {
        if (!node.computed) return;
        const expression = tsNode(node);
        check(node, expression, expression.expression, expression.argumentExpression, false);
      },
      BinaryExpression(node) {
        if (node.operator !== "in") return;
        const expression = tsNode(node);
        check(node, expression, expression.right, expression.left, true);
      },
    };
  },
};
