// Hindley-Milner type inference (Algorithm W) for the language in lang.js.
//
// Two things beyond the textbook version matter here, both for the playground:
//   1. Every unification carries a *reason* - the span it came from and a
//      sentence explaining what was being compared. That is what turns
//      "unification failure" into "this branch has type Int but the other
//      branch has type Bool".
//   2. Inference records a trace of the constraints it solved and the type
//      variables it bound, so the page can show the machinery working.

import { LangError } from './lang.js';

export const tInt = { kind: 'con', name: 'Int', args: [] };
export const tBool = { kind: 'con', name: 'Bool', args: [] };
export const tString = { kind: 'con', name: 'String', args: [] };

export const tList = (item) => ({ kind: 'con', name: 'List', args: [item] });
export const tPair = (a, b) => ({ kind: 'con', name: 'Pair', args: [a, b] });
export const tFn = (from, to) => ({ kind: 'con', name: '->', args: [from, to] });

// ---------- pretty printing ----------

// Type variables are numbered internally; a reader wants `a -> a`, not
// `t17 -> t17`. Names are assigned in order of first appearance.
export function prettyType(type, names = new Map()) {
  return show(type, 0, names);

  function varName(id) {
    if (!names.has(id)) {
      const n = names.size;
      const letter = String.fromCharCode(97 + (n % 26));
      names.set(id, n < 26 ? letter : letter + Math.floor(n / 26));
    }
    return names.get(id);
  }

  function show(t, prec, ns) {
    if (t.kind === 'var') return varName(t.id);
    if (t.name === '->') {
      const text = `${show(t.args[0], 1, ns)} -> ${show(t.args[1], 0, ns)}`;
      return prec > 0 ? `(${text})` : text;
    }
    if (t.name === 'List') return `[${show(t.args[0], 0, ns)}]`;
    if (t.name === 'Pair') return `(${show(t.args[0], 0, ns)}, ${show(t.args[1], 0, ns)})`;
    return t.name;
  }
}

// ---------- the inference engine ----------

class Engine {
  constructor() {
    this.nextId = 0;
    this.subst = new Map();
    this.trace = [];
    this.bindings = []; // let-bound names, for the side table
  }

  fresh() {
    return { kind: 'var', id: this.nextId++ };
  }

  // Follow the substitution one level: the shallow representative of a type.
  prune(type) {
    let t = type;
    while (t.kind === 'var' && this.subst.has(t.id)) t = this.subst.get(t.id);
    return t;
  }

  // Fully apply the substitution, for display and generalization.
  resolve(type) {
    const t = this.prune(type);
    if (t.kind === 'var') return t;
    return { kind: 'con', name: t.name, args: t.args.map((a) => this.resolve(a)) };
  }

  freeVars(type, into = new Set()) {
    const t = this.prune(type);
    if (t.kind === 'var') into.add(t.id);
    else t.args.forEach((a) => this.freeVars(a, into));
    return into;
  }

  occurs(id, type) {
    const t = this.prune(type);
    if (t.kind === 'var') return t.id === id;
    return t.args.some((a) => this.occurs(id, a));
  }

  // ctx = { span, explain(leftText, rightText) -> message }
  unify(left, right, ctx) {
    const a = this.prune(left);
    const b = this.prune(right);
    if (a === b || (a.kind === 'var' && b.kind === 'var' && a.id === b.id)) return;

    if (a.kind === 'var') return this.bind(a, b, ctx);
    if (b.kind === 'var') return this.bind(b, a, ctx);

    if (a.name !== b.name || a.args.length !== b.args.length) this.mismatch(left, right, ctx);
    for (let k = 0; k < a.args.length; k++) this.unify(a.args[k], b.args[k], ctx);
  }

  bind(v, type, ctx) {
    if (this.occurs(v.id, type)) {
      const names = new Map();
      const varText = prettyType(v, names);
      const typeText = prettyType(this.resolve(type), names);
      throw new LangError(
        `This value would have to contain itself: its type ${varText} would need to be the same as ${typeText}. ` +
        'That is an infinite type, so no finite type fits.',
        ctx.span,
        'type',
      );
    }
    this.subst.set(v.id, type);
    this.trace.push({
      kind: 'bind',
      span: ctx.span,
      text: `${prettyType(v, this.names)} := ${prettyType(this.resolve(type), this.names)}`,
      why: ctx.label,
    });
  }

  // Report the two whole types the constraint started from, not the innermost
  // pair that happened to clash: `[Int]` against `[Bool]` reads better than
  // `Int` against `Bool` when the user is looking at two lists.
  mismatch(left, right, ctx) {
    const [outerLeft, outerRight] = ctx.top ?? [left, right];
    const names = new Map();
    const leftText = prettyType(this.resolve(outerLeft), names);
    const rightText = prettyType(this.resolve(outerRight), names);
    throw new LangError(ctx.explain(leftText, rightText), ctx.span, 'type');
  }

  constrain(left, right, ctx) {
    ctx.top = [left, right];
    this.trace.push({
      kind: 'constraint',
      span: ctx.span,
      text: `${prettyType(this.resolve(left), this.names)}  ~  ${prettyType(this.resolve(right), this.names)}`,
      why: ctx.label,
    });
    this.unify(left, right, ctx);
  }

  instantiate(scheme) {
    if (scheme.quantified.length === 0) return scheme.type;
    const swap = new Map(scheme.quantified.map((id) => [id, this.fresh()]));
    const walk = (t) => {
      const p = this.prune(t);
      if (p.kind === 'var') return swap.get(p.id) ?? p;
      return { kind: 'con', name: p.name, args: p.args.map(walk) };
    };
    return walk(scheme.type);
  }

  generalize(env, type) {
    const bound = new Set();
    for (let scope = env; scope; scope = scope.parent) {
      for (const scheme of scope.vars.values()) {
        const free = this.freeVars(scheme.type);
        for (const id of free) if (!scheme.quantified.includes(id)) bound.add(id);
      }
    }
    const quantified = [...this.freeVars(type)].filter((id) => !bound.has(id));
    return { quantified, type: this.resolve(type) };
  }
}

// A shared naming map so the trace reads consistently: the `a` in step 3 is
// the same `a` as in step 9.
Object.defineProperty(Engine.prototype, 'names', {
  get() {
    if (!this._names) this._names = new Map();
    return this._names;
  },
});

const mono = (type) => ({ quantified: [], type });

function scheme(build) {
  // Schemes for builtins are written with negative ids so they never collide
  // with the engine's fresh variables; instantiate() replaces them anyway.
  let id = -1;
  const v = () => ({ kind: 'var', id: id-- });
  const type = build(v);
  const quantified = [];
  (function collect(t) {
    if (t.kind === 'var') { if (!quantified.includes(t.id)) quantified.push(t.id); }
    else t.args.forEach(collect);
  })(type);
  return { quantified, type };
}

export function builtinTypes() {
  const vars = new Map();
  vars.set('map', scheme((v) => { const a = v(), b = v(); return tFn(tFn(a, b), tFn(tList(a), tList(b))); }));
  vars.set('filter', scheme((v) => { const a = v(); return tFn(tFn(a, tBool), tFn(tList(a), tList(a))); }));
  vars.set('foldl', scheme((v) => { const a = v(), b = v(); return tFn(tFn(b, tFn(a, b)), tFn(b, tFn(tList(a), b))); }));
  vars.set('length', scheme((v) => tFn(tList(v()), tInt)));
  vars.set('head', scheme((v) => { const a = v(); return tFn(tList(a), a); }));
  vars.set('tail', scheme((v) => { const a = v(); return tFn(tList(a), tList(a)); }));
  vars.set('fst', scheme((v) => { const a = v(), b = v(); return tFn(tPair(a, b), a); }));
  vars.set('snd', scheme((v) => { const a = v(), b = v(); return tFn(tPair(a, b), b); }));
  vars.set('show', scheme((v) => tFn(v(), tString)));
  return { vars, parent: null };
}

const ARITH = new Set(['+', '-', '*', '/', '%']);
const ORDER = new Set(['<', '<=', '>', '>=']);
const LOGIC = new Set(['&&', '||']);

const OP_WORD = { '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide', '%': 'take the remainder of' };

function lookupScheme(env, name) {
  for (let scope = env; scope; scope = scope.parent) {
    const found = scope.vars.get(name);
    if (found) return found;
  }
  return null;
}

const side = (node, which) => (which === 0 ? node.left : node.right);

/**
 * Infer the type of a parsed program.
 * Returns { type, pretty, bindings, trace, constraints }.
 * Throws LangError (phase 'type') with a span on failure.
 */
export function infer(node, env = builtinTypes()) {
  const engine = new Engine();
  const type = inferNode(engine, env, node);
  const resolved = engine.resolve(type);
  const names = new Map();
  const pretty = prettyType(resolved, names);
  return {
    type: resolved,
    pretty,
    bindings: engine.bindings.map((b) => ({
      name: b.name,
      span: b.span,
      pretty: prettyType(engine.resolve(b.type), new Map()),
    })),
    trace: engine.trace,
    constraints: engine.trace.filter((step) => step.kind === 'constraint'),
  };
}

export function typeOf(src, parseFn) {
  return infer(parseFn(src)).pretty;
}

function inferNode(engine, env, node) {
  switch (node.kind) {
    case 'int': return tInt;
    case 'bool': return tBool;
    case 'string': return tString;

    case 'var': {
      const found = lookupScheme(env, node.name);
      if (!found) {
        throw new LangError(`\`${node.name}\` is not defined anywhere in scope.`, node.span, 'type');
      }
      const type = engine.instantiate(found);
      if (found.quantified.length > 0) {
        engine.trace.push({
          kind: 'instantiate',
          span: node.span,
          text: `${node.name} : ${prettyType(found.type, new Map())}  fresh copy for this use:  ${prettyType(engine.resolve(type), engine.names)}`,
          why: 'a polymorphic name gets fresh type variables at every use',
        });
      }
      return type;
    }

    case 'lambda': {
      const paramType = engine.fresh();
      engine.trace.push({
        kind: 'assume',
        span: node.paramSpan,
        text: `assume ${node.param} : ${prettyType(paramType, engine.names)}`,
        why: 'the parameter type is unknown, so it starts as a fresh variable',
      });
      const inner = { vars: new Map([[node.param, mono(paramType)]]), parent: env };
      const bodyType = inferNode(engine, inner, node.body);
      return tFn(paramType, bodyType);
    }

    case 'apply': {
      const fnType = inferNode(engine, env, node.fn);
      const argType = inferNode(engine, env, node.arg);
      const resultType = engine.fresh();
      engine.constrain(fnType, tFn(argType, resultType), {
        span: node.arg.span,
        label: 'applying a function to an argument',
        explain: (fnText, wantedText) => explainApply(engine, fnType, argType, fnText, wantedText),
      });
      return resultType;
    }

    case 'let': {
      const valueType = inferNode(engine, env, node.value);
      const generalized = engine.generalize(env, valueType);
      engine.trace.push({
        kind: 'generalize',
        span: node.nameSpan,
        text: `${node.name} : ${prettyType(generalized.type, new Map())}${generalized.quantified.length ? '   (usable at any type)' : ''}`,
        why: generalized.quantified.length
          ? 'generalization: variables not tied to anything outside become polymorphic'
          : 'nothing left free to generalize',
      });
      engine.bindings.push({ name: node.name, span: node.nameSpan, type: valueType });
      const inner = { vars: new Map([[node.name, generalized]]), parent: env };
      return inferNode(engine, inner, node.body);
    }

    case 'letrec': {
      const selfType = engine.fresh();
      const inner = { vars: new Map([[node.name, mono(selfType)]]), parent: env };
      engine.trace.push({
        kind: 'assume',
        span: node.nameSpan,
        text: `assume ${node.name} : ${prettyType(selfType, engine.names)}`,
        why: 'a recursive definition may use its own name before its type is known',
      });
      const valueType = inferNode(engine, inner, node.value);
      engine.constrain(selfType, valueType, {
        span: node.nameSpan,
        label: `the recursive uses of \`${node.name}\` must agree with its definition`,
        explain: (assumed, actual) =>
          `\`${node.name}\` is used recursively as ${assumed}, but its definition has type ${actual}.`,
      });
      const generalized = engine.generalize(env, selfType);
      engine.trace.push({
        kind: 'generalize',
        span: node.nameSpan,
        text: `${node.name} : ${prettyType(generalized.type, new Map())}`,
        why: 'the recursive function is generalized once its own type is settled',
      });
      engine.bindings.push({ name: node.name, span: node.nameSpan, type: selfType });
      const outer = { vars: new Map([[node.name, generalized]]), parent: env };
      return inferNode(engine, outer, node.body);
    }

    case 'if': {
      const condType = inferNode(engine, env, node.cond);
      engine.constrain(condType, tBool, {
        span: node.cond.span,
        label: 'the condition of `if` must be a yes/no value',
        explain: (found) => `The condition of \`if\` must be Bool, but this is ${found}.`,
      });
      const thenType = inferNode(engine, env, node.then);
      const elseType = inferNode(engine, env, node.otherwise);
      engine.constrain(thenType, elseType, {
        span: node.otherwise.span,
        label: 'both branches of `if` must produce the same type',
        explain: (thenText, elseText) =>
          `This branch has type ${elseText} but the other branch has type ${thenText}. ` +
          'Both branches of an `if` have to agree, because only one of them runs and the rest of the program cannot tell which.',
      });
      return thenType;
    }

    case 'pair':
      return tPair(inferNode(engine, env, node.left), inferNode(engine, env, node.right));

    case 'list': {
      const itemType = engine.fresh();
      node.items.forEach((item, index) => {
        const t = inferNode(engine, env, item);
        engine.constrain(itemType, t, {
          span: item.span,
          label: 'every element of a list has the same type',
          explain: (firstText, thisText) =>
            index === 0
              ? `This list element has type ${thisText}, which does not fit.`
              : `This list element has type ${thisText}, but the earlier elements have type ${firstText}. A list holds one type of thing.`,
        });
      });
      return tList(itemType);
    }

    case 'binary':
      return inferBinary(engine, env, node);

    default:
      throw new LangError(`Internal error: cannot type \`${node.kind}\`.`, node.span, 'type');
  }
}

function inferBinary(engine, env, node) {
  const op = node.op;
  const leftType = inferNode(engine, env, node.left);
  const rightType = inferNode(engine, env, node.right);

  const operand = (which, type, expected, noun) => {
    engine.constrain(type, expected, {
      span: side(node, which).span,
      label: `\`${op}\` needs ${noun} on both sides`,
      explain: (found) =>
        `The ${which === 0 ? 'left' : 'right'} side of \`${op}\` has type ${found}, but \`${op}\` needs ${noun}` +
        (op === '+' && found === 'String'
          ? '. To join two pieces of text use `++`.'
          : '.'),
    });
  };

  if (ARITH.has(op)) {
    operand(0, leftType, tInt, `whole numbers (Int) to ${OP_WORD[op]}`);
    operand(1, rightType, tInt, `whole numbers (Int) to ${OP_WORD[op]}`);
    return tInt;
  }
  if (op === '++') {
    operand(0, leftType, tString, 'text (String)');
    operand(1, rightType, tString, 'text (String)');
    return tString;
  }
  if (ORDER.has(op)) {
    operand(0, leftType, tInt, 'whole numbers (Int) to compare');
    operand(1, rightType, tInt, 'whole numbers (Int) to compare');
    return tBool;
  }
  if (LOGIC.has(op)) {
    operand(0, leftType, tBool, 'yes/no values (Bool)');
    operand(1, rightType, tBool, 'yes/no values (Bool)');
    return tBool;
  }
  if (op === '==' || op === '!=') {
    engine.constrain(leftType, rightType, {
      span: node.right.span,
      label: `\`${op}\` compares two values of the same type`,
      explain: (leftText, rightText) =>
        `This side of \`${op}\` has type ${rightText}, but the other side has type ${leftText}. ` +
        'Only values of the same type can be compared.',
    });
    return tBool;
  }
  if (op === '::') {
    engine.constrain(rightType, tList(leftType), {
      span: node.right.span,
      label: '`::` puts a value on the front of a list of the same type',
      explain: (found, wanted) =>
        `The right side of \`::\` has type ${found}, but putting this value on the front needs ${wanted}.`,
    });
    return rightType;
  }
  throw new LangError(`Internal error: cannot type operator \`${op}\`.`, node.span, 'type');
}

// Phrased from the types of the function and the argument as they stand when
// the constraint fails, which is what a reader is looking at on screen.
function explainApply(engine, fnType, argType, fnText, wantedText) {
  const fn = engine.resolve(fnType);
  if (fn.kind === 'con' && fn.name !== '->') {
    return `This is not a function: the thing being applied has type ${prettyType(fn, new Map())}, so it cannot take an argument.`;
  }
  if (fn.kind === 'con' && fn.name === '->') {
    const names = new Map();
    const paramText = prettyType(fn.args[0], names);
    const argText = prettyType(engine.resolve(argType), names);
    if (paramText !== argText) {
      return `This function expects ${paramText}, but it is given ${argText}.`;
    }
  }
  return `This function has type ${fnText}, but here it would have to be ${wantedText}.`;
}
