import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize, parse, evaluate, showValue, LangError } from './lang.js';
import { infer } from './infer.js';

const typeOf = (src) => infer(parse(src)).pretty;
const valueOf = (src) => showValue(evaluate(parse(src)));

function caught(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof LangError, `expected a LangError, got ${err}`);
    return err;
  }
  assert.fail('expected a LangError, but nothing was thrown');
}

const parseError = (src) => caught(() => parse(src));

function failure(src) {
  try {
    const ast = parse(src);
    infer(ast);
  } catch (err) {
    assert.ok(err instanceof LangError, `expected a LangError, got ${err}`);
    return err;
  }
  assert.fail(`expected \`${src}\` to fail, but it typechecked`);
}

// ---------- tokenizer ----------

test('tokenizer splits operators longest-first and keeps spans', () => {
  const tokens = tokenize('a <= b');
  assert.deepEqual(tokens.map((t) => t.type), ['name', '<=', 'name', 'end']);
  assert.deepEqual(tokens[1].span, { start: 2, end: 4 });
});

test('tokenizer handles strings, comments and negative-looking arrows', () => {
  assert.deepEqual(tokenize('"hi" -- trailing comment').map((t) => t.value), ['hi', null]);
  assert.deepEqual(tokenize('\\x -> x').map((t) => t.type), ['\\', 'name', '->', 'name', 'end']);
  assert.throws(() => tokenize('"unterminated'), /never closed/);
});

// ---------- parser ----------

test('every AST node carries a span that covers its source text', () => {
  const src = 'let x = 1 in x + 2';
  const ast = parse(src);
  const seen = [];
  (function walk(node) {
    assert.ok(node.span, `node ${node.kind} has no span`);
    assert.ok(node.span.end > node.span.start, `node ${node.kind} has an empty span`);
    seen.push(node.kind);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object' && value.kind) walk(value);
      if (Array.isArray(value)) value.forEach((v) => v && v.kind && walk(v));
    }
  })(ast);
  assert.deepEqual(ast.span, { start: 0, end: src.length });
  assert.ok(seen.includes('let') && seen.includes('binary') && seen.includes('var'));
});

test('parser round-trips structure: application is left-associative, `->` is not', () => {
  const app = parse('f x y');
  assert.equal(app.kind, 'apply');
  assert.equal(app.fn.kind, 'apply');
  assert.equal(app.fn.fn.name, 'f');
  assert.equal(app.arg.name, 'y');

  const lam = parse('\\x y -> x');
  assert.equal(lam.kind, 'lambda');
  assert.equal(lam.param, 'x');
  assert.equal(lam.body.param, 'y');
});

test('parser accepts both lambda spellings and multi-argument let', () => {
  assert.equal(typeOf('fun x -> x'), 'a -> a');
  assert.equal(typeOf('\\x -> x'), 'a -> a');
  assert.equal(valueOf('let add a b = a + b in add 2 3'), '5');
});

test('operator precedence follows the usual arithmetic reading', () => {
  assert.equal(valueOf('1 + 2 * 3'), '7');
  assert.equal(valueOf('(1 + 2) * 3'), '9');
  assert.equal(valueOf('1 + 2 == 3 && 2 < 3'), 'true');
});

test('parse errors point at the offending token', () => {
  const src = 'let x = 1 then 2';
  const err = parseError(src);
  assert.match(err.message, /expected `in`/);
  assert.equal(src.slice(err.span.start, err.span.end), 'then');

  const unclosed = parseError('(1 + 2');
  assert.match(unclosed.message, /expected `\)`/);
  assert.match(unclosed.message, /end of the program/);

  const leftover = parseError('1 + 2 )');
  assert.match(leftover.message, /left over/);
});

// ---------- evaluator ----------

test('evaluator computes a set of programs', () => {
  assert.equal(valueOf('if 2 > 1 then "yes" else "no"'), '"yes"');
  assert.equal(valueOf('map (\\x -> x * x) [1,2,3,4]'), '[1, 4, 9, 16]');
  assert.equal(valueOf('filter (\\x -> x % 2 == 0) [1,2,3,4,5,6]'), '[2, 4, 6]');
  assert.equal(valueOf('foldl (\\acc -> \\x -> acc + x) 0 [1,2,3,4]'), '10');
  assert.equal(valueOf('length [1,2,3]'), '3');
  assert.equal(valueOf('head (1 :: [2,3])'), '1');
  assert.equal(valueOf('(1, true)'), '(1, true)');
  assert.equal(valueOf('"ab" ++ "cd"'), '"abcd"');
});

test('let rec evaluates a recursive function', () => {
  const factorial = 'let rec fact n = if n <= 1 then 1 else n * fact (n - 1) in fact 10';
  assert.equal(valueOf(factorial), '3628800');
});

test('runaway recursion is stopped rather than hanging', () => {
  const err = caught(() => evaluate(parse('let rec loop n = loop n in loop 1')));
  assert.equal(err.phase, 'run');
  assert.match(err.message, /ran for too long/);
});

// ---------- inference ----------

test('identity is polymorphic and applications instantiate it', () => {
  assert.equal(typeOf('\\x -> x'), 'a -> a');
  assert.equal(typeOf('\\x -> \\y -> x'), 'a -> b -> a');
  assert.equal(typeOf('(\\x -> x) 1'), 'Int');
  assert.equal(typeOf('\\f -> \\x -> f (f x)'), '(a -> a) -> a -> a');
});

test('literals, lists, pairs and operators get concrete types', () => {
  assert.equal(typeOf('1 + 2'), 'Int');
  assert.equal(typeOf('1 < 2'), 'Bool');
  assert.equal(typeOf('"a" ++ "b"'), 'String');
  assert.equal(typeOf('[1,2,3]'), '[Int]');
  assert.equal(typeOf('(1, "a")'), '(Int, String)');
  assert.equal(typeOf('\\x -> [x]'), 'a -> [a]');
});

test('map usage instantiates correctly', () => {
  assert.equal(typeOf('map'), '(a -> b) -> [a] -> [b]');
  assert.equal(typeOf('map (\\x -> x * 2) [1,2,3]'), '[Int]');
  assert.equal(typeOf('map (\\x -> x > 0) [1,2,3]'), '[Bool]');
  assert.equal(typeOf('map show'), '[a] -> [String]');
  assert.equal(typeOf('let rec fact n = if n <= 1 then 1 else n * fact (n - 1) in map fact'), '[Int] -> [Int]');
});

test('let-polymorphism: a let-bound identity works at two types, a lambda-bound one does not', () => {
  assert.equal(typeOf('let id = \\x -> x in (id 1, id true)'), '(Int, Bool)');

  // The same expression with `id` bound by a lambda instead of a let: the
  // parameter type is monomorphic inside the body, so the second use clashes.
  const err = failure('(\\id -> (id 1, id true)) (\\x -> x)');
  assert.equal(err.phase, 'type');
  assert.match(err.message, /Int/);
  assert.match(err.message, /Bool/);
});

test('let rec generalizes once its own type is settled', () => {
  // `xs == []` compares against an empty list of any element type, so `len`
  // stays polymorphic in the element - which is the honest, most general type.
  assert.equal(typeOf('let rec len xs = if xs == [] then 0 else 1 + len (tail xs) in len'), '[a] -> Int');
  assert.equal(typeOf('let rec len xs = if xs == [] then 0 else 1 + len (tail xs) in len [1,2,3]'), 'Int');
  assert.equal(typeOf('let rec fact n = if n <= 1 then 1 else n * fact (n - 1) in fact'), 'Int -> Int');
});

test('inference reports the let-binding types the side table shows', () => {
  const result = infer(parse('let id = \\x -> x in let two = id 2 in two'));
  assert.deepEqual(result.bindings.map((b) => [b.name, b.pretty]), [['id', 'a -> a'], ['two', 'Int']]);
  assert.equal(result.pretty, 'Int');
});

test('inference records a readable trace of constraints and bindings', () => {
  const result = infer(parse('(\\x -> x + 1) 41'));
  assert.ok(result.trace.length > 0);
  assert.ok(result.constraints.length > 0);
  assert.ok(result.trace.every((step) => typeof step.text === 'string' && step.span));
  assert.ok(result.trace.some((step) => step.kind === 'assume' && step.text.includes('assume x')));
  assert.ok(result.trace.some((step) => step.kind === 'bind' && /:=/.test(step.text)));
  assert.ok(result.constraints.every((step) => step.text.includes('~')));
});

// ---------- the broken examples in the playground ----------

test('mismatched if branches: right span, both types named', () => {
  const src = 'if 1 < 2 then 10 else "ten"';
  const err = failure(src);
  assert.equal(src.slice(err.span.start, err.span.end), '"ten"');
  assert.match(err.message, /This branch has type String but the other branch has type Int/);
});

test('adding an Int to a String: names the operator and suggests ++', () => {
  const src = '1 + "two"';
  const err = failure(src);
  assert.equal(src.slice(err.span.start, err.span.end), '"two"');
  assert.match(err.message, /right side of `\+` has type String/);
  assert.match(err.message, /`\+\+`/);
});

test('occurs check triggers on \\x -> x x', () => {
  const err = failure('\\x -> x x');
  assert.equal(err.phase, 'type');
  assert.match(err.message, /contain itself/);
  assert.match(err.message, /infinite type/);
  assert.ok(err.span.end > err.span.start);
});

test('a list with mixed element types blames the offending element', () => {
  const src = '[1, 2, true]';
  const err = failure(src);
  assert.equal(src.slice(err.span.start, err.span.end), 'true');
  assert.match(err.message, /A list holds one type of thing/);
});

test('applying a non-function and misapplying a function are distinguished', () => {
  assert.match(failure('1 2').message, /not a function/);
  assert.match(failure('map 1 [1,2]').message, /expects/);
});

test('unbound names are reported by name with their span', () => {
  const src = 'let x = 1 in x + wobble';
  const err = failure(src);
  assert.equal(src.slice(err.span.start, err.span.end), 'wobble');
  assert.match(err.message, /`wobble` is not defined/);
});

test('the working examples the page ships with all typecheck and run', () => {
  const examples = [
    'let id = \\x -> x in (id 1, id true)',
    'map (\\x -> x * x) [1,2,3,4,5]',
    'let rec fact n = if n <= 1 then 1 else n * fact (n - 1) in map fact [1,2,3,4,5]',
    'let compose = \\f -> \\g -> \\x -> f (g x) in compose (\\n -> n + 1) (\\n -> n * 2) 20',
  ];
  for (const src of examples) {
    const ast = parse(src);
    assert.ok(infer(ast).pretty.length > 0, src);
    assert.ok(showValue(evaluate(ast)).length > 0, src);
  }
});
