// A small ML-flavoured expression language: tokenizer, parser, evaluator.
// Every AST node carries a { start, end } span into the source text, because
// the playground underlines errors and labels bindings by position.

export class LangError extends Error {
  constructor(message, span, phase) {
    super(message);
    this.name = 'LangError';
    this.span = span;
    this.phase = phase; // 'parse' | 'type' | 'run'
  }
}

const KEYWORDS = new Set(['let', 'rec', 'in', 'if', 'then', 'else', 'fun', 'true', 'false']);

// Longest first so '<=' wins over '<'.
const SYMBOLS = [
  '->', '::', '++', '==', '!=', '<=', '>=', '&&', '||',
  '\\', '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '[', ']', ',',
];

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  const push = (type, value, start) => tokens.push({ type, value, span: { start, end: i } });

  while (i < src.length) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    if (c === '-' && src[i + 1] === '-') { // line comment
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    if (c >= '0' && c <= '9') {
      const start = i;
      while (i < src.length && src[i] >= '0' && src[i] <= '9') i++;
      push('int', Number(src.slice(start, i)), start);
      continue;
    }

    if (c === '"') {
      const start = i;
      i++;
      let text = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const esc = src[i + 1];
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          i += 2;
        } else {
          text += src[i];
          i++;
        }
      }
      if (i >= src.length) throw new LangError('This string is never closed.', { start, end: src.length }, 'parse');
      i++;
      push('string', text, start);
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_']/.test(src[i])) i++;
      const word = src.slice(start, i);
      push(KEYWORDS.has(word) ? word : 'name', word, start);
      continue;
    }

    const sym = SYMBOLS.find((s) => src.startsWith(s, i));
    if (sym) {
      const start = i;
      i += sym.length;
      push(sym, sym, start);
      continue;
    }

    const start = i;
    i++;
    throw new LangError(`I do not know what to do with the character ${JSON.stringify(c)}.`, { start, end: i }, 'parse');
  }

  tokens.push({ type: 'end', value: null, span: { start: src.length, end: src.length } });
  return tokens;
}

// Binary operator precedence, loosest first. All left-associative except '::'.
const LEVELS = [
  { ops: ['||'], right: false },
  { ops: ['&&'], right: false },
  { ops: ['==', '!=', '<', '<=', '>', '>='], right: false },
  { ops: ['::'], right: true },
  { ops: ['+', '-', '++'], right: false },
  { ops: ['*', '/', '%'], right: false },
];

const ATOM_STARTERS = new Set(['int', 'string', 'name', 'true', 'false', '(', '[']);

export function parse(src) {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const at = (type) => tokens[pos].type === type;
  const next = () => tokens[pos++];

  const describe = (tok) => (tok.type === 'end' ? 'the end of the program' : `\`${tok.value}\``);

  function expect(type, context) {
    if (!at(type)) {
      const tok = peek();
      throw new LangError(`I expected \`${type}\` ${context}, but found ${describe(tok)}.`, tok.span, 'parse');
    }
    return next();
  }

  function span(from, to) {
    return { start: from.start, end: to.end };
  }

  function parseExpr() {
    const tok = peek();
    if (tok.type === 'let') return parseLet();
    if (tok.type === '\\' || tok.type === 'fun') return parseLambda();
    if (tok.type === 'if') return parseIf();
    return parseBinary(0);
  }

  function parseNames(context) {
    const names = [];
    while (at('name')) {
      const tok = next();
      names.push({ name: tok.value, span: tok.span });
    }
    if (names.length === 0) {
      const tok = peek();
      throw new LangError(`I expected a name ${context}, but found ${describe(tok)}.`, tok.span, 'parse');
    }
    return names;
  }

  function parseLet() {
    const start = next().span; // 'let'
    const recursive = at('rec');
    if (recursive) next();
    const [binder, ...params] = parseNames(recursive ? 'after `let rec`' : 'after `let`');
    expect('=', `after the name \`${binder.name}\``);
    let value = parseExpr();
    for (let k = params.length - 1; k >= 0; k--) {
      value = { kind: 'lambda', param: params[k].name, paramSpan: params[k].span, body: value, span: span(params[k].span, value.span) };
    }
    expect('in', `after the definition of \`${binder.name}\``);
    const body = parseExpr();
    if (recursive && params.length === 0 && value.kind !== 'lambda') {
      throw new LangError(`\`let rec ${binder.name}\` must define a function, otherwise it can never finish computing itself.`, value.span, 'parse');
    }
    return {
      kind: recursive ? 'letrec' : 'let',
      name: binder.name,
      nameSpan: binder.span,
      value,
      body,
      span: span(start, body.span),
    };
  }

  function parseLambda() {
    const start = next().span; // '\' or 'fun'
    const params = parseNames('after the start of a function');
    expect('->', 'after the function parameters');
    const body = parseExpr();
    let node = body;
    for (let k = params.length - 1; k >= 0; k--) {
      node = {
        kind: 'lambda',
        param: params[k].name,
        paramSpan: params[k].span,
        body: node,
        span: span(k === 0 ? start : params[k].span, body.span),
      };
    }
    return node;
  }

  function parseIf() {
    const start = next().span; // 'if'
    const cond = parseExpr();
    expect('then', 'after the condition of `if`');
    const then = parseExpr();
    expect('else', 'after the `then` branch');
    const otherwise = parseExpr();
    return { kind: 'if', cond, then, otherwise, span: span(start, otherwise.span) };
  }

  function parseBinary(level) {
    if (level >= LEVELS.length) return parseApply();
    const { ops, right } = LEVELS[level];
    let left = parseBinary(level + 1);
    while (ops.includes(peek().type)) {
      const opTok = next();
      const rhs = right ? parseBinary(level) : parseBinary(level + 1);
      left = {
        kind: 'binary',
        op: opTok.value,
        opSpan: opTok.span,
        left,
        right: rhs,
        span: span(left.span, rhs.span),
      };
      if (right) break;
    }
    return left;
  }

  function parseApply() {
    let fn = parseAtom();
    while (ATOM_STARTERS.has(peek().type)) {
      const arg = parseAtom();
      fn = { kind: 'apply', fn, arg, span: span(fn.span, arg.span) };
    }
    return fn;
  }

  function parseAtom() {
    const tok = peek();
    switch (tok.type) {
      case 'int':
        next();
        return { kind: 'int', value: tok.value, span: tok.span };
      case 'string':
        next();
        return { kind: 'string', value: tok.value, span: tok.span };
      case 'true':
      case 'false':
        next();
        return { kind: 'bool', value: tok.type === 'true', span: tok.span };
      case 'name':
        next();
        return { kind: 'var', name: tok.value, span: tok.span };
      case '-': {
        // Unary minus, only where an atom was expected.
        next();
        const operand = parseAtom();
        return {
          kind: 'binary',
          op: '-',
          opSpan: tok.span,
          left: { kind: 'int', value: 0, span: tok.span },
          right: operand,
          span: span(tok.span, operand.span),
        };
      }
      case '(': {
        next();
        const first = parseExpr();
        if (at(',')) {
          next();
          const second = parseExpr();
          const close = expect(')', 'to close a pair');
          return { kind: 'pair', left: first, right: second, span: span(tok.span, close.span) };
        }
        const close = expect(')', 'to close a bracketed expression');
        return { ...first, span: span(tok.span, close.span) };
      }
      case '[': {
        next();
        const items = [];
        if (!at(']')) {
          items.push(parseExpr());
          while (at(',')) {
            next();
            items.push(parseExpr());
          }
        }
        const close = expect(']', 'to close a list');
        return { kind: 'list', items, span: span(tok.span, close.span) };
      }
      default:
        throw new LangError(`I expected an expression here, but found ${describe(tok)}.`, tok.span, 'parse');
    }
  }

  const program = parseExpr();
  if (!at('end')) {
    const tok = peek();
    throw new LangError(`The program looked finished, but there is still ${describe(tok)} left over.`, tok.span, 'parse');
  }
  return program;
}

// ---------- evaluation ----------

class Closure {
  constructor(param, body, env) {
    this.param = param;
    this.body = body;
    this.env = env;
  }
}

class Builtin {
  constructor(name, arity, fn, applied = []) {
    this.name = name;
    this.arity = arity;
    this.fn = fn;
    this.applied = applied;
  }
}

const STEP_BUDGET = 200000;
// The evaluator recurses on the JS stack, so a runaway program would blow the
// stack long before the step budget noticed. Cap the depth well under it and
// report a proper LangError instead of a RangeError.
const DEPTH_BUDGET = 2000;

export function evaluate(node, env = builtinValues()) {
  return evalNode(node, env, { steps: 0, depth: 0 });
}

function evalNode(node, env, state) {
  if (++state.steps > STEP_BUDGET || state.depth > DEPTH_BUDGET) {
    throw new LangError('This program ran for too long and was stopped. Is the recursion missing a base case?', node.span, 'run');
  }
  switch (node.kind) {
    case 'int':
    case 'string':
      return node.value;
    case 'bool':
      return node.value;
    case 'var': {
      const cell = lookup(env, node.name);
      if (!cell) throw new LangError(`\`${node.name}\` is not defined.`, node.span, 'run');
      return cell.value;
    }
    case 'lambda':
      return new Closure(node.param, node.body, env);
    case 'let': {
      const value = evalNode(node.value, env, state);
      return evalNode(node.body, { vars: new Map([[node.name, { value }]]), parent: env }, state);
    }
    case 'letrec': {
      const cell = { value: undefined };
      const inner = { vars: new Map([[node.name, cell]]), parent: env };
      cell.value = evalNode(node.value, inner, state);
      return evalNode(node.body, inner, state);
    }
    case 'if': {
      const cond = evalNode(node.cond, env, state);
      return cond ? evalNode(node.then, env, state) : evalNode(node.otherwise, env, state);
    }
    case 'pair':
      return { pair: [evalNode(node.left, env, state), evalNode(node.right, env, state)] };
    case 'list':
      return node.items.map((item) => evalNode(item, env, state));
    case 'binary':
      return evalBinary(node, env, state);
    case 'apply': {
      const fn = evalNode(node.fn, env, state);
      const arg = evalNode(node.arg, env, state);
      return applyValue(fn, arg, node, state);
    }
    default:
      throw new LangError(`Internal error: unknown node \`${node.kind}\`.`, node.span, 'run');
  }
}

function evalBinary(node, env, state) {
  const a = evalNode(node.left, env, state);
  if (node.op === '&&') return a ? evalNode(node.right, env, state) : false;
  if (node.op === '||') return a ? true : evalNode(node.right, env, state);
  const b = evalNode(node.right, env, state);
  switch (node.op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/':
      if (b === 0) throw new LangError('Division by zero.', node.span, 'run');
      return Math.trunc(a / b);
    case '%':
      if (b === 0) throw new LangError('Division by zero.', node.span, 'run');
      return a % b;
    case '++': return a + b;
    case '::': return [a, ...b];
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '==': return equalValues(a, b);
    case '!=': return !equalValues(a, b);
    default:
      throw new LangError(`Internal error: unknown operator \`${node.op}\`.`, node.span, 'run');
  }
}

function equalValues(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, k) => equalValues(item, b[k]));
  }
  if (a && b && a.pair && b.pair) return equalValues(a.pair[0], b.pair[0]) && equalValues(a.pair[1], b.pair[1]);
  return a === b;
}

function applyValue(fn, arg, node, state) {
  if (fn instanceof Closure) {
    const env = { vars: new Map([[fn.param, { value: arg }]]), parent: fn.env };
    state.depth++;
    try {
      return evalNode(fn.body, env, state);
    } finally {
      state.depth--;
    }
  }
  if (fn instanceof Builtin) {
    const applied = [...fn.applied, arg];
    if (applied.length < fn.arity) return new Builtin(fn.name, fn.arity, fn.fn, applied);
    return fn.fn(applied, (f, a) => applyValue(f, a, node, state), node);
  }
  throw new LangError(`${showValue(fn)} is not a function, so it cannot be applied to an argument.`, node.span, 'run');
}

function lookup(env, name) {
  for (let scope = env; scope; scope = scope.parent) {
    const cell = scope.vars.get(name);
    if (cell) return cell;
  }
  return null;
}

export function builtinValues() {
  const vars = new Map();
  const def = (name, arity, fn) => vars.set(name, { value: new Builtin(name, arity, fn) });

  def('map', 2, ([f, xs], apply) => xs.map((x) => apply(f, x)));
  def('filter', 2, ([f, xs], apply) => xs.filter((x) => apply(f, x)));
  def('foldl', 3, ([f, init, xs], apply) => xs.reduce((acc, x) => apply(apply(f, acc), x), init));
  def('length', 1, ([xs]) => xs.length);
  def('head', 1, ([xs], _apply, node) => {
    if (xs.length === 0) throw new LangError('`head` was given an empty list.', node.span, 'run');
    return xs[0];
  });
  def('tail', 1, ([xs], _apply, node) => {
    if (xs.length === 0) throw new LangError('`tail` was given an empty list.', node.span, 'run');
    return xs.slice(1);
  });
  def('fst', 1, ([p]) => p.pair[0]);
  def('snd', 1, ([p]) => p.pair[1]);
  def('show', 1, ([v]) => showValue(v));

  return { vars, parent: null };
}

export function showValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(showValue).join(', ')}]`;
  if (value instanceof Closure) return '<function>';
  if (value instanceof Builtin) return `<builtin ${value.name}>`;
  if (value && value.pair) return `(${showValue(value.pair[0])}, ${showValue(value.pair[1])})`;
  return String(value);
}

export function run(src) {
  return evaluate(parse(src));
}
