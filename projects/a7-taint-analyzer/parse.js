// A minimal recursive-descent parser for a JS-like subset: assignments,
// if/else, while, calls, member access, string concatenation, return.
//
// Deliberately small. No user-defined functions, no arrays/objects, no
// template literals, no bracket indexing — see README "what this is not".
// Every node carries a `line` (1-based) so the UI can highlight source.

export class ParseError extends Error {}

const KEYWORDS = new Set(['let', 'const', 'var', 'if', 'else', 'while', 'return', 'true', 'false']);

// ---------------------------------------------------------------- lexer ---

function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  const isDigit = (c) => c >= '0' && c <= '9';
  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdentPart = (c) => /[A-Za-z0-9_$]/.test(c);

  while (i < n) {
    const c = src[i];

    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      const startLine = line;
      let j = i + 1;
      let value = '';
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') { value += src[j + 1]; j += 2; continue; }
        if (src[j] === '\n') line++;
        value += src[j];
        j++;
      }
      if (j >= n) throw new ParseError(`unterminated string at line ${startLine}`);
      tokens.push({ type: 'string', value, line: startLine });
      i = j + 1;
      continue;
    }

    if (isDigit(c)) {
      let j = i;
      while (j < n && (isDigit(src[j]) || src[j] === '.')) j++;
      tokens.push({ type: 'number', value: Number(src.slice(i, j)), line });
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      tokens.push({ type: KEYWORDS.has(word) ? 'keyword' : 'ident', value: word, line });
      i = j;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      tokens.push({ type: 'punct', value: two, line });
      i += 2;
      continue;
    }

    if ('+-*/=(){}.,;<>!'.includes(c)) {
      tokens.push({ type: 'punct', value: c, line });
      i++;
      continue;
    }

    throw new ParseError(`unexpected character ${JSON.stringify(c)} at line ${line}`);
  }

  tokens.push({ type: 'eof', value: null, line });
  return tokens;
}

// --------------------------------------------------------------- parser ---

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(offset = 0) { return this.tokens[this.pos + offset]; }
  at(type, value) {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  atPunct(value) { return this.at('punct', value); }
  atKeyword(value) { return this.at('keyword', value); }

  advance() { return this.tokens[this.pos++]; }

  expect(type, value) {
    if (!this.at(type, value)) {
      const t = this.peek();
      throw new ParseError(`expected ${value ?? type} but got ${t.value ?? t.type} at line ${t.line}`);
    }
    return this.advance();
  }

  parseProgram() {
    const body = [];
    while (!this.at('eof')) body.push(this.parseStatement());
    return { type: 'Program', body, line: 1 };
  }

  parseBlock() {
    this.expect('punct', '{');
    const body = [];
    while (!this.atPunct('}')) body.push(this.parseStatement());
    this.expect('punct', '}');
    return body;
  }

  parseStatement() {
    if (this.atKeyword('let') || this.atKeyword('const') || this.atKeyword('var')) return this.parseVarDecl();
    if (this.atKeyword('if')) return this.parseIf();
    if (this.atKeyword('while')) return this.parseWhile();
    if (this.atKeyword('return')) return this.parseReturn();
    if (this.at('ident', 'function')) return this.parseFunctionDecl();
    if (this.atPunct('{')) return { type: 'Block', body: this.parseBlock(), line: this.peek().line };
    return this.parseExprOrAssignStatement();
  }

  parseFunctionDecl() {
    const line = this.advance().line; // 'function'
    const nameTok = this.expect('ident');
    this.expect('punct', '(');
    const params = [];
    while (!this.atPunct(')')) {
      params.push(this.expect('ident').value);
      if (this.atPunct(',')) this.advance();
    }
    this.expect('punct', ')');
    const body = this.parseBlock();
    return { type: 'FunctionDecl', name: nameTok.value, params, body, line };
  }

  parseVarDecl() {
    const kindTok = this.advance();
    const line = kindTok.line;
    const nameTok = this.expect('ident');
    this.expect('punct', '=');
    const init = this.parseExpr();
    this.expect('punct', ';');
    return { type: 'VarDecl', kind: kindTok.value, name: nameTok.value, init, line };
  }

  parseIf() {
    const line = this.advance().line; // 'if'
    this.expect('punct', '(');
    const test = this.parseExpr();
    this.expect('punct', ')');
    const cons = this.parseBlock();
    let alt = null;
    if (this.atKeyword('else')) {
      this.advance();
      alt = this.atKeyword('if') ? [this.parseIf()] : this.parseBlock();
    }
    return { type: 'If', test, cons, alt, line };
  }

  parseWhile() {
    const line = this.advance().line; // 'while'
    this.expect('punct', '(');
    const test = this.parseExpr();
    this.expect('punct', ')');
    const body = this.parseBlock();
    return { type: 'While', test, body, line };
  }

  parseReturn() {
    const line = this.advance().line; // 'return'
    let value = null;
    if (!this.atPunct(';')) value = this.parseExpr();
    this.expect('punct', ';');
    return { type: 'Return', value, line };
  }

  parseExprOrAssignStatement() {
    const line = this.peek().line;
    const expr = this.parseExpr();
    if (this.atPunct('=')) {
      if (expr.type !== 'Identifier' && expr.type !== 'Member') {
        throw new ParseError(`invalid assignment target at line ${line}`);
      }
      this.advance();
      const value = this.parseExpr();
      this.expect('punct', ';');
      return { type: 'Assign', target: expr, value, line };
    }
    this.expect('punct', ';');
    return { type: 'ExprStmt', expr, line };
  }

  // precedence climbing: || , && , equality , relational , additive , unary , call/member/primary
  parseExpr() { return this.parseOr(); }

  parseOr() {
    let left = this.parseAnd();
    while (this.atPunct('||')) {
      const line = this.advance().line;
      left = { type: 'Binary', op: '||', left, right: this.parseAnd(), line };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseEquality();
    while (this.atPunct('&&')) {
      const line = this.advance().line;
      left = { type: 'Binary', op: '&&', left, right: this.parseEquality(), line };
    }
    return left;
  }

  parseEquality() {
    let left = this.parseRelational();
    while (this.atPunct('==') || this.atPunct('!=')) {
      const op = this.advance();
      left = { type: 'Binary', op: op.value, left, right: this.parseRelational(), line: op.line };
    }
    return left;
  }

  parseRelational() {
    let left = this.parseAdditive();
    while (this.atPunct('<') || this.atPunct('>') || this.atPunct('<=') || this.atPunct('>=')) {
      const op = this.advance();
      left = { type: 'Binary', op: op.value, left, right: this.parseAdditive(), line: op.line };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseUnary();
    while (this.atPunct('+') || this.atPunct('-')) {
      const op = this.advance();
      left = { type: 'Binary', op: op.value, left, right: this.parseUnary(), line: op.line };
    }
    return left;
  }

  parseUnary() {
    if (this.atPunct('!') || this.atPunct('-')) {
      const op = this.advance();
      return { type: 'Unary', op: op.value, arg: this.parseUnary(), line: op.line };
    }
    return this.parseCallOrMember();
  }

  parseCallOrMember() {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.atPunct('.')) {
        this.advance();
        const prop = this.expect('ident');
        expr = { type: 'Member', object: expr, property: prop.value, line: prop.line };
      } else if (this.atPunct('(')) {
        const line = this.advance().line;
        const args = [];
        while (!this.atPunct(')')) {
          args.push(this.parseExpr());
          if (this.atPunct(',')) this.advance();
        }
        this.expect('punct', ')');
        expr = { type: 'Call', callee: expr, args, line };
      } else {
        break;
      }
    }
    return expr;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'number') { this.advance(); return { type: 'NumberLit', value: t.value, line: t.line }; }
    if (t.type === 'string') { this.advance(); return { type: 'StringLit', value: t.value, line: t.line }; }
    if (t.type === 'keyword' && (t.value === 'true' || t.value === 'false')) {
      this.advance();
      return { type: 'BoolLit', value: t.value === 'true', line: t.line };
    }
    if (t.type === 'ident') { this.advance(); return { type: 'Identifier', name: t.value, line: t.line }; }
    if (this.atPunct('(')) {
      this.advance();
      const expr = this.parseExpr();
      this.expect('punct', ')');
      return expr;
    }
    throw new ParseError(`unexpected token ${t.value ?? t.type} at line ${t.line}`);
  }
}

export function parse(src) {
  const tokens = tokenize(src);
  const parser = new Parser(tokens);
  const program = parser.parseProgram();
  return program;
}

// Renders the dotted path of a Member/Identifier chain, e.g. `request.query.name`.
// Returns null if the expression is not a simple member/identifier chain
// (e.g. it's a call or a literal) — used to match sources/sinks/sanitizers.
export function exprToPath(expr) {
  if (expr.type === 'Identifier') return expr.name;
  if (expr.type === 'Member') {
    const base = exprToPath(expr.object);
    return base === null ? null : `${base}.${expr.property}`;
  }
  return null;
}
