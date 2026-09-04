import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from './parse.js';
import { buildCFG, runTaintAnalysis, reachingDefinitions } from './analysis.js';
import { EXAMPLES } from './examples.js';

function exampleSrc(id) {
  return EXAMPLES.find((e) => e.id === id).code;
}

// ------------------------------------------------------------- parser ---

test('parser produces expected AST shape for a var decl and assignment', () => {
  const prog = parse('let x = 1;\nx = x + 2;\n');
  assert.equal(prog.type, 'Program');
  assert.equal(prog.body.length, 2);
  assert.equal(prog.body[0].type, 'VarDecl');
  assert.equal(prog.body[0].name, 'x');
  assert.equal(prog.body[0].init.type, 'NumberLit');
  assert.equal(prog.body[1].type, 'Assign');
  assert.equal(prog.body[1].target.type, 'Identifier');
  assert.equal(prog.body[1].value.type, 'Binary');
  assert.equal(prog.body[1].value.op, '+');
});

test('parser handles member access, calls, and string concatenation', () => {
  const prog = parse('let s = "a" + request.query.name;\ndb.query(s);\n');
  const decl = prog.body[0];
  assert.equal(decl.init.type, 'Binary');
  assert.equal(decl.init.right.type, 'Member');
  assert.equal(decl.init.right.property, 'name');
  const call = prog.body[1].expr;
  assert.equal(call.type, 'Call');
  assert.equal(call.callee.type, 'Member');
  assert.equal(call.callee.property, 'query');
});

test('parser handles if/else and while with correct line numbers', () => {
  const prog = parse(`if (x == 1) {
  y = 2;
} else {
  y = 3;
}
while (x < 5) {
  x = x + 1;
}
`);
  assert.equal(prog.body[0].type, 'If');
  assert.equal(prog.body[0].cons.length, 1);
  assert.equal(prog.body[0].alt.length, 1);
  assert.equal(prog.body[1].type, 'While');
  assert.equal(prog.body[1].line, 6);
});

test('parser records a source span (line) on every node', () => {
  const prog = parse('let a = 1;\nlet b = 2;\n');
  assert.equal(prog.body[0].line, 1);
  assert.equal(prog.body[1].line, 2);
});

// ------------------------------------------------------------------ CFG ---

test('CFG of straight-line code is a single block with no successors', () => {
  const cfg = buildCFG(parse('let a = 1;\nlet b = a + 1;\n'));
  assert.equal(cfg.blocks.length, 1);
  assert.deepEqual(cfg.blocks[0].succs, []);
});

test('CFG of if/else has 4 blocks: test, then, else, merge', () => {
  const cfg = buildCFG(parse(`if (x == 1) {
  y = 2;
} else {
  y = 3;
}
`));
  assert.equal(cfg.blocks.length, 4);
  const testBlock = cfg.blocks[0];
  assert.equal(testBlock.succs.length, 2);
  const merge = cfg.blocks[cfg.blocks.length - 1];
  assert.equal(merge.preds.length, 2);
});

test('CFG of a while loop has a back edge into the header', () => {
  const cfg = buildCFG(parse(`while (x < 5) {
  x = x + 1;
}
`));
  // entry -> header -> body -> header (back edge), header -> after
  const header = cfg.blocks.find((b) => b.kind === 'loop-header');
  assert.ok(header, 'expected a loop-header block');
  assert.ok(header.preds.length >= 2, 'loop header should have a predecessor from before the loop and from the back edge');
  assert.equal(header.succs.length, 2); // into body, and out after
});

// ------------------------------------------------------- taint analysis ---

test('taint analysis reaches a fixed point (terminates) on a loop program', () => {
  const cfg = buildCFG(parse(exampleSrc('loop')));
  const result = runTaintAnalysis(cfg);
  assert.ok(result.stats.iterations > cfg.blocks.length, 'a loop should need more worklist steps than blocks (re-processing)');
  assert.ok(Number.isFinite(result.stats.iterations));
});

test('a tainted-to-sink program yields exactly one finding with the correct path', () => {
  const cfg = buildCFG(parse(exampleSrc('vulnerable')));
  const result = runTaintAnalysis(cfg);
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.sourceLabel, 'request.query.name');
  assert.equal(finding.sinkLabel, 'db.query(...)');
  assert.ok(finding.path.length >= 2);
  assert.equal(finding.path[0].label, 'source: request.query.name');
});

test('a sanitized program yields zero findings', () => {
  const cfg = buildCFG(parse(exampleSrc('sanitized')));
  const result = runTaintAnalysis(cfg);
  assert.equal(result.findings.length, 0);
});

test('sanitized on only one branch still yields a finding (join is union, not intersection)', () => {
  const cfg = buildCFG(parse(exampleSrc('one-branch')));
  const result = runTaintAnalysis(cfg);
  assert.equal(result.findings.length, 1);
});

test('sanitized on every branch yields zero findings (no false positive at the merge)', () => {
  const cfg = buildCFG(parse(exampleSrc('both-branches')));
  const result = runTaintAnalysis(cfg);
  assert.equal(result.findings.length, 0);
});

test('taint propagates through indirection and reaches an innerHTML sink', () => {
  const cfg = buildCFG(parse(exampleSrc('indirect')));
  const result = runTaintAnalysis(cfg);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].sinkLabel, 'element.innerHTML');
});

test('worklist history is monotone: the OUT set at each block never shrinks between visits', () => {
  const cfg = buildCFG(parse(exampleSrc('loop')));
  const result = runTaintAnalysis(cfg);
  const lastSeenOut = new Map();
  for (const entry of result.history) {
    const prev = lastSeenOut.get(entry.blockId);
    if (prev) {
      for (const v of prev) assert.ok(entry.out.includes(v), `variable ${v} disappeared from block ${entry.blockId}'s OUT set`);
    }
    lastSeenOut.set(entry.blockId, entry.out);
  }
});

// -------------------------------------------------- reaching definitions ---

test('reaching definitions gives the expected sets on a known straight-line example', () => {
  const cfg = buildCFG(parse(`let a = 1;
let b = a + 1;
a = b + 1;
`));
  const rd = reachingDefinitions(cfg);
  // defs: 0 = a@1, 1 = b@2, 2 = a@3 (redefinition kills def 0)
  assert.equal(rd.defs.length, 3);
  const blockId = cfg.blocks[0].id;
  assert.deepEqual(rd.final[blockId].in, []);
  // out should contain the latest def of each var: b (id 1) and a (id 2), not id 0 (killed)
  assert.deepEqual(rd.final[blockId].out, [1, 2]);
});

test('reaching definitions merges at an if/else join', () => {
  const cfg = buildCFG(parse(`let a = 1;
if (a == 1) {
  a = 2;
} else {
  a = 3;
}
let b = a;
`));
  const rd = reachingDefinitions(cfg);
  const mergeBlock = cfg.blocks[cfg.blocks.length - 1];
  // Both branch definitions of `a` should reach the merge block's IN set.
  const thenDef = rd.defs.find((d) => d.line === 3);
  const elseDef = rd.defs.find((d) => d.line === 5);
  assert.ok(rd.final[mergeBlock.id].in.includes(thenDef.id));
  assert.ok(rd.final[mergeBlock.id].in.includes(elseDef.id));
});
