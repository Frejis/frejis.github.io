// Control-flow graph construction, a taint-tracking dataflow analysis, and a
// second analysis (reaching definitions) built on the same worklist pattern.
//
// The taint analysis is a classic forward "may" monotone framework:
//   lattice:      per variable, untainted (bottom) sqsubseteq tainted (top)
//   state:        Map<varName, Provenance> at each CFG point (absence = untainted)
//   join (merge): set union of tainted vars  -> if EITHER predecessor path
//                 leaves a variable tainted, the merge point is tainted. That
//                 is why "sanitized on only one branch" still gets flagged,
//                 and "sanitized on every branch" does not.
//   transfer:     per-statement function, monotone in its input state
//   worklist:     blocks re-processed until IN/OUT stop changing (fixed point)
//
// See README for the soundness/precision tradeoffs this implies.

import { exprToPath } from './parse.js';

// ---------------------------------------------------------- vocabulary ---

export const SOURCES = ['request.query', 'request.body', 'request.params', 'process.argv'];
export const SOURCE_FNS = ['readInput'];
export const SANITIZERS = ['escape', 'parameterize', 'sanitize'];
export const SINK_CALLS = ['db.query', 'eval', 'exec', 'child_process.exec'];
export const SINK_MEMBER_PROPS = ['innerHTML'];

function isSource(path) {
  return path !== null && SOURCES.some((s) => path === s || path.startsWith(s + '.'));
}
function isSourceFn(path) {
  return path !== null && SOURCE_FNS.includes(path);
}
function isSanitizer(path) {
  if (path === null) return false;
  return SANITIZERS.includes(path) || SANITIZERS.includes(path.split('.').pop());
}
function isSinkCall(path) {
  return path !== null && SINK_CALLS.some((s) => path === s || path.endsWith('.' + s));
}

// ------------------------------------------------------------------ CFG ---
// Basic blocks of straight-line statements. `If` and `While` are recorded as
// a "test" pseudo-statement at the end of their block so the analysis can
// evaluate the condition expression for taint too (e.g. `if (tainted)` alone
// doesn't propagate taint anywhere, but it does mean the condition itself
// might belong in a report for a richer sink set — not used here, kept for
// completeness/inspection in the UI).

let blockCounter;

function newBlock(blocks) {
  const block = { id: blockCounter++, stmts: [], succs: [], preds: [], kind: 'plain' };
  blocks.push(block);
  return block;
}
function addEdge(a, b) {
  a.succs.push(b.id);
  b.preds.push(a.id);
}

// Programs are analyzed as a single unit (see README: intraprocedural, with
// direct calls handled by inlining taint through call arguments at the call
// site rather than a full interprocedural summary). If the program is a
// single top-level function declaration — the common shape of the bundled
// examples, e.g. `function handler(request) { ... }` — its body is the unit
// analyzed; otherwise the top-level statements are.
export function buildCFG(program) {
  const blocks = [];
  blockCounter = 0;
  const entry = newBlock(blocks);
  const body = program.body.length === 1 && program.body[0].type === 'FunctionDecl'
    ? program.body[0].body
    : program.body;
  const exitId = processStmts(body, entry, blocks);
  return { blocks, entry: entry.id, exit: exitId };
}

function processStmts(stmts, current, blocks) {
  for (const stmt of stmts) {
    if (current === null) current = newBlock(blocks); // unreachable, but keep for reporting
    current = processStmt(stmt, current, blocks);
  }
  return current === null ? null : current.id;
}

function blockById(blocks, id) { return blocks.find((b) => b.id === id); }

function processStmt(stmt, current, blocks) {
  switch (stmt.type) {
    case 'VarDecl':
    case 'Assign':
    case 'ExprStmt':
      current.stmts.push(stmt);
      return current;
    case 'Return':
      current.stmts.push(stmt);
      return null; // no fallthrough
    case 'Block':
      return blockById(blocks, processStmts(stmt.body, current, blocks)) ?? null;
    case 'If': {
      current.stmts.push({ type: 'Test', test: stmt.test, line: stmt.line, kind: 'if' });
      const consEntry = newBlock(blocks);
      addEdge(current, consEntry);
      const consExitId = processStmts(stmt.cons, consEntry, blocks);

      const altEntry = newBlock(blocks);
      addEdge(current, altEntry);
      const altExitId = stmt.alt ? processStmts(stmt.alt, altEntry, blocks) : altEntry.id;

      const merge = newBlock(blocks);
      let reachable = false;
      if (consExitId !== null) { addEdge(blockById(blocks, consExitId), merge); reachable = true; }
      if (altExitId !== null) { addEdge(blockById(blocks, altExitId), merge); reachable = true; }
      return reachable ? merge : null;
    }
    case 'While': {
      const header = newBlock(blocks);
      addEdge(current, header);
      header.stmts.push({ type: 'Test', test: stmt.test, line: stmt.line, kind: 'while' });
      header.kind = 'loop-header';

      const bodyEntry = newBlock(blocks);
      addEdge(header, bodyEntry);
      const bodyExitId = processStmts(stmt.body, bodyEntry, blocks);
      if (bodyExitId !== null) addEdge(blockById(blocks, bodyExitId), header); // back edge

      const after = newBlock(blocks);
      addEdge(header, after);
      return after;
    }
    default:
      throw new Error(`unhandled statement type ${stmt.type}`);
  }
}

// -------------------------------------------------------- taint values ---
// A Provenance is either null (untainted) or { line, label, path } where
// `path` is the ordered list of { line, label } steps taint travelled
// through, source first.

function sourceProv(label, line) {
  return { line, label, path: [{ line, label: `source: ${label}` }] };
}
function extendProv(prov, step) {
  return { ...prov, path: [...prov.path, step] };
}

// Evaluate whether an expression is tainted given a Map<var, Provenance>.
// Returns { tainted, provenance }.
function evalTaint(expr, state) {
  switch (expr.type) {
    case 'NumberLit':
    case 'StringLit':
    case 'BoolLit':
      return { tainted: false, provenance: null };
    case 'Identifier': {
      const prov = state.get(expr.name);
      return prov ? { tainted: true, provenance: prov } : { tainted: false, provenance: null };
    }
    case 'Member': {
      const path = exprToPath(expr);
      if (isSource(path)) return { tainted: true, provenance: sourceProv(path, expr.line) };
      const objRes = evalTaint(expr.object, state);
      return objRes.tainted
        ? { tainted: true, provenance: extendProv(objRes.provenance, { line: expr.line, label: `.${expr.property} accessed` }) }
        : { tainted: false, provenance: null };
    }
    case 'Call': {
      const path = exprToPath(expr.callee);
      if (isSanitizer(path)) return { tainted: false, provenance: null };
      if (isSourceFn(path)) return { tainted: true, provenance: sourceProv(`${path}()`, expr.line) };
      for (const arg of expr.args) {
        const argRes = evalTaint(arg, state);
        if (argRes.tainted) {
          return {
            tainted: true,
            provenance: extendProv(argRes.provenance, { line: expr.line, label: `through call ${path ?? '(...)'}(...)` }),
          };
        }
      }
      return { tainted: false, provenance: null };
    }
    case 'Binary': {
      const left = evalTaint(expr.left, state);
      const right = evalTaint(expr.right, state);
      const hit = left.tainted ? left : right.tainted ? right : null;
      if (!hit) return { tainted: false, provenance: null };
      const label = expr.op === '+' ? 'string concatenation' : `binary ${expr.op}`;
      return { tainted: true, provenance: extendProv(hit.provenance, { line: expr.line, label }) };
    }
    case 'Unary':
      return evalTaint(expr.arg, state);
    default:
      return { tainted: false, provenance: null };
  }
}

// target: Identifier | Member. Returns the base variable name that should
// carry taint. Assigning into a member expression (`obj.field = x`) taints
// the *whole* base object, coarsely — see README.
function assignTargetName(target) {
  return target.type === 'Identifier' ? target.name : exprToPath(target).split('.')[0];
}

// Apply one statement's transfer function to a state map, returning a new
// map (input is not mutated). `sinkHits` (optional) collects any sink usages
// observed while walking this statement, with a full witness path.
function transferStmt(stmt, state, sinkHits) {
  const next = new Map(state);
  switch (stmt.type) {
    case 'VarDecl': {
      const res = evalTaint(stmt.init, state);
      if (res.tainted) next.set(stmt.name, res.provenance); else next.delete(stmt.name);
      checkSink(stmt.init, state, stmt, sinkHits);
      return next;
    }
    case 'Assign': {
      const res = evalTaint(stmt.value, state);
      const name = assignTargetName(stmt.target);
      const sinkProp = stmt.target.type === 'Member' ? stmt.target.property : null;
      if (sinkProp && SINK_MEMBER_PROPS.includes(sinkProp) && res.tainted) {
        sinkHits?.push(makeFinding(stmt, exprToPath(stmt.target) ?? sinkProp, res.provenance));
      }
      if (res.tainted) next.set(name, res.provenance); else next.delete(name);
      checkSink(stmt.value, state, stmt, sinkHits);
      return next;
    }
    case 'ExprStmt':
      checkSink(stmt.expr, state, stmt, sinkHits);
      return next;
    case 'Return':
      if (stmt.value) checkSink(stmt.value, state, stmt, sinkHits);
      return next;
    case 'Test':
      checkSink(stmt.test, state, stmt, sinkHits);
      return next;
    default:
      return next;
  }
}

function makeFinding(stmt, sinkLabel, provenance) {
  return {
    sinkLine: stmt.line,
    sinkLabel,
    sourceLabel: provenance.path[0].label.replace(/^source: /, ''),
    sourceLine: provenance.path[0].line,
    path: provenance.path,
    message: `untrusted data from ${provenance.path[0].label.replace(/^source: /, '')} (line ${provenance.path[0].line}) reaches ${sinkLabel} at line ${stmt.line} without sanitization`,
    severity: 'bad',
  };
}

// Walks an expression tree looking for calls into SINK_CALLS, reporting a
// finding for every tainted argument found.
function checkSink(expr, state, stmt, sinkHits) {
  if (!sinkHits || !expr) return;
  if (expr.type === 'Call') {
    const path = exprToPath(expr.callee);
    if (isSinkCall(path)) {
      for (const arg of expr.args) {
        const res = evalTaint(arg, state);
        if (res.tainted) sinkHits.push(makeFinding(stmt, `${path}(...)`, res.provenance));
      }
    }
    for (const arg of expr.args) checkSink(arg, state, stmt, sinkHits);
    checkSink(expr.callee, state, stmt, sinkHits);
  } else if (expr.type === 'Binary') {
    checkSink(expr.left, state, stmt, sinkHits);
    checkSink(expr.right, state, stmt, sinkHits);
  } else if (expr.type === 'Unary') {
    checkSink(expr.arg, state, stmt, sinkHits);
  } else if (expr.type === 'Member') {
    checkSink(expr.object, state, stmt, sinkHits);
  }
}

function keySet(map) { return [...map.keys()].sort(); }
function sameKeys(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Runs a whole block's statements in order, from an IN map, returning the
// OUT map. Optionally collects sink findings along the way.
function transferBlock(block, inState, sinkHits) {
  let state = inState;
  for (const stmt of block.stmts) state = transferStmt(stmt, state, sinkHits);
  return state;
}

// ---------------------------------------------------------- worklist ----

export function runTaintAnalysis(cfg) {
  const t0 = performance.now();
  const blocks = cfg.blocks;
  const IN = new Map(blocks.map((b) => [b.id, new Map()]));
  const OUT = new Map(blocks.map((b) => [b.id, new Map()]));
  const history = [];

  // Process in block-id order first for a deterministic, human-followable
  // trace; a real worklist doesn't care about order, only that it drains.
  let worklist = blocks.map((b) => b.id);
  let iterations = 0;
  const seen = new Set(worklist);

  while (worklist.length > 0) {
    const id = worklist.shift();
    seen.delete(id);
    const block = blockById(blocks, id);
    iterations++;

    const merged = new Map();
    for (const predId of block.preds) {
      for (const [k, v] of OUT.get(predId)) if (!merged.has(k)) merged.set(k, v);
    }
    const inChanged = !sameKeys(keySet(merged), keySet(IN.get(id)));
    if (inChanged) IN.set(id, merged);

    const newOut = transferBlock(block, IN.get(id));
    const outChanged = !sameKeys(keySet(newOut), keySet(OUT.get(id)));

    history.push({
      step: iterations,
      blockId: id,
      in: keySet(IN.get(id)),
      out: keySet(outChanged ? newOut : OUT.get(id)),
      changed: outChanged,
    });

    if (outChanged) {
      OUT.set(id, newOut);
      for (const succId of block.succs) {
        if (!seen.has(succId)) { seen.add(succId); worklist.push(succId); }
      }
    }
  }

  // Findings: single deterministic pass now that IN sets are final.
  const findings = [];
  for (const block of blocks) transferBlock(block, IN.get(block.id), findings);

  const t1 = performance.now();

  return {
    cfg,
    history,
    final: Object.fromEntries(blocks.map((b) => [b.id, { in: keySet(IN.get(b.id)), out: keySet(OUT.get(b.id)) }])),
    findings: dedupeFindings(findings),
    stats: { blocks: blocks.length, iterations, timeMs: t1 - t0 },
  };
}

function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${f.sinkLine}|${f.sinkLabel}|${f.sourceLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// ------------------------------------------------- reaching definitions ---
// A second, independent instance of the same worklist pattern: a "may"
// analysis over the set of assignment sites (not values) that can reach a
// program point. GEN kills any earlier definition of the same variable.
//
// domain:  set of def ids reaching a point
// join:    union
// transfer(block): GEN(block) union (IN(block) - KILL(block))

export function reachingDefinitions(cfg) {
  const blocks = cfg.blocks;
  const defs = []; // { id, name, line, blockId }
  for (const block of blocks) {
    for (const stmt of block.stmts) {
      if (stmt.type === 'VarDecl' || (stmt.type === 'Assign' && stmt.target.type === 'Identifier')) {
        const name = stmt.type === 'VarDecl' ? stmt.name : stmt.target.name;
        defs.push({ id: defs.length, name, line: stmt.line, blockId: block.id });
      }
    }
  }

  const genOf = new Map(); // blockId -> Set(defId), keeps only the LAST def of each var in the block
  const killOf = new Map(); // blockId -> Set(defId of other blocks' defs of same vars)
  for (const block of blocks) {
    const lastByName = new Map();
    for (const d of defs) if (d.blockId === block.id) lastByName.set(d.name, d.id);
    genOf.set(block.id, new Set(lastByName.values()));
    const killed = new Set();
    for (const d of defs) if (lastByName.has(d.name) && d.id !== lastByName.get(d.name)) killed.add(d.id);
    killOf.set(block.id, killed);
  }

  const IN = new Map(blocks.map((b) => [b.id, new Set()]));
  const OUT = new Map(blocks.map((b) => [b.id, new Set()]));
  let worklist = blocks.map((b) => b.id);
  const seen = new Set(worklist);
  let iterations = 0;

  while (worklist.length > 0) {
    const id = worklist.shift();
    seen.delete(id);
    iterations++;
    const block = blockById(blocks, id);

    const merged = new Set();
    for (const predId of block.preds) for (const d of OUT.get(predId)) merged.add(d);
    IN.set(id, merged);

    const out = new Set(genOf.get(id));
    for (const d of merged) if (!killOf.get(id).has(d)) out.add(d);

    const changed = out.size !== OUT.get(id).size || [...out].some((d) => !OUT.get(id).has(d));
    if (changed) {
      OUT.set(id, out);
      for (const succId of block.succs) if (!seen.has(succId)) { seen.add(succId); worklist.push(succId); }
    }
  }

  return {
    defs,
    iterations,
    final: Object.fromEntries(blocks.map((b) => [b.id, { in: [...IN.get(b.id)].sort((a, c) => a - c), out: [...OUT.get(b.id)].sort((a, c) => a - c) }])),
  };
}
