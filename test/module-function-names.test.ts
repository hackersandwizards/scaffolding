import ts from "typescript";
import { expect, test } from "vitest";
import { defined } from "../lib/defined.js";
import {
  hoistedVariableDeclarations,
  isFunctionInitializer,
  moduleFunctionNames,
  moduleVariableBindings,
  unwrapTypeExpression,
} from "../lib/module-function-names.ts";

function parseSource(code: string, fileName = "sample.ts"): ts.SourceFile {
  return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest);
}

function firstExpression(code: string): ts.Expression {
  const source = parseSource(code);
  const statement = source.statements[0] as ts.ExpressionStatement;
  return statement.expression;
}

test.each([
  ["((() => 1))", ts.SyntaxKind.ArrowFunction],
  ["(function () {}) as unknown", ts.SyntaxKind.FunctionExpression],
  ["<unknown>(() => 2)", ts.SyntaxKind.ArrowFunction],
  ["(() => 3) satisfies () => number", ts.SyntaxKind.ArrowFunction],
  ["((() => 4)!) as unknown satisfies unknown", ts.SyntaxKind.ArrowFunction],
  ["42", ts.SyntaxKind.NumericLiteral],
] as const)("unwrapTypeExpression strips wrappers from %s", (code, expectedKind) => {
  expect(unwrapTypeExpression(firstExpression(code)).kind).toBe(expectedKind);
});

test.each([
  [
    "if (cond) { var hoisted = () => 1; let scoped = () => 2; const blocked = () => 3; }",
    ["hoisted"],
  ],
  ["function outer() { var inner = () => 1; }", []],
  ["class Box { static { var inside = () => 1; } }", []],
  ["namespace Ns { var inside = () => 1; }", []],
] as const)("hoistedVariableDeclarations collects only hoisted vars from %s", (code, expected) => {
  const source = parseSource(code);
  const names = hoistedVariableDeclarations(
    defined(source.statements[0], "first parsed statement"),
  ).map((decl) => decl.name.getText(source));
  expect(names).toEqual(expected);
});

test.each([
  ["const a = 1; let b = 2; function c() {} if (x) { var d = 3; }", ["a", "b", "d"]],
  ["function only() {}", []],
] as const)(
  "moduleVariableBindings collects top-level and hoisted bindings for %s",
  (code, expected) => {
    const source = parseSource(code);
    const names = moduleVariableBindings(source).map((decl) => decl.name.getText(source));
    expect(names).toEqual(expected);
  },
);

test.each([
  ["() => 1", true],
  ["function named() {}", true],
  ["((() => 1) as unknown)!", true],
  ["{ run() {} }", false],
  ["123", false],
] as const)("isFunctionInitializer(%s) is %s", (code, expected) => {
  expect(isFunctionInitializer(firstExpression(`(${code})`))).toBe(expected);
});

test.each([
  [
    "function overloaded(x: number): number; function overloaded(x: number) { return x; }",
    ["overloaded"],
  ],
  ["const { destructured } = { destructured: () => 1 }; var empty;", []],
  [
    "const second = (() => 1) satisfies () => number; function first() {} if (ok) { var third = function () {}; }",
    ["first", "second", "third"],
  ],
] as const)("moduleFunctionNames yields expected names in order for %s", (code, expected) => {
  expect([...moduleFunctionNames(parseSource(code))]).toEqual(expected);
});
