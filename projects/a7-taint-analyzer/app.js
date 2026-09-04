// app.js — all DOM wiring. Logic lives in parse.js / analysis.js / layout.js
// and has no DOM references.
import { parse, ParseError } from './parse.js';
import { buildCFG, runTaintAnalysis, reachingDefinitions, SOURCES, SOURCE_FNS, SANITIZERS, SINK_CALLS, SINK_MEMBER_PROPS } from './analysis.js';
import { layoutCFG } from './layout.js';
import { EXAMPLES, DEFAULT_EXAMPLE_ID } from './examples.js';

const $ = (id) => document.getElementById(id);

const exampleButtons = $('example-buttons');
const codeInput = $('code-input');
const gutter = $('gutter');
const analysisSelect = $('analysis-select');
const analyzeBtn = $('analyze-btn');
const parseErrorBox = $('parse-error');
const findingsHeading = $('findings-heading');
const findingsBlurb = $('findings-blurb');
const findingsList = $('findings-list');
const cfgContainer = $('cfg-container');
const cfgLegend = $('cfg-legend');
const stepFirstBtn = $('step-first-btn');
const stepPrevBtn = $('step-prev-btn');
const stepNextBtn = $('step-next-btn');
const stepLastBtn = $('step-last-btn');
const stepCounter = $('step-counter');
const stepSlider = $('step-slider');
const stepDetail = $('step-detail');
const statsGrid = $('stats-grid');
const runBenchmarkBtn = $('run-benchmark-btn');
const benchStatus = $('bench-status');
const benchCanvas = $('bench-canvas');
const benchLegend = $('bench-legend');

let state = {
  cfg: null,
  taint: null,       // result of runTaintAnalysis, when analysisSelect === 'taint'
  reaching: null,     // result of reachingDefinitions, when analysisSelect === 'reaching'
  mode: 'taint',
  activeFindingIdx: null,
  stepIdx: 0,
};

// ---------------------------------------------------------- example bar ---

for (const ex of EXAMPLES) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = ex.title;
  btn.title = ex.blurb;
  btn.addEventListener('click', () => {
    codeInput.value = ex.code;
    renderGutterSkeleton();
    runAnalysis();
  });
  exampleButtons.appendChild(btn);
}

// -------------------------------------------------------------- gutter ---

function renderGutterSkeleton() {
  const lines = codeInput.value.split('\n').length;
  gutter.innerHTML = '';
  for (let i = 1; i <= lines; i++) {
    const div = document.createElement('div');
    div.className = 'gutter-line';
    div.dataset.line = String(i);
    div.textContent = String(i);
    gutter.appendChild(div);
  }
  syncGutterScroll();
}

function syncGutterScroll() { gutter.scrollTop = codeInput.scrollTop; }
codeInput.addEventListener('scroll', syncGutterScroll);
codeInput.addEventListener('input', renderGutterSkeleton);

function markGutter(kind, lines) {
  for (const line of lines) {
    const el = gutter.querySelector(`.gutter-line[data-line="${line}"]`);
    if (el) el.classList.add(kind);
  }
}

function clearGutter() {
  for (const el of gutter.querySelectorAll('.gutter-line')) {
    el.classList.remove('is-source', 'is-sink', 'is-tainted', 'is-witness');
  }
}

// ------------------------------------------------------------ analysis ---

function collectLinesByKind(program) {
  // Walk statements looking for source/sink expressions textually, for the
  // gutter overview (independent of whether they actually reach anything —
  // that's what the findings/CFG panel is for).
  const sourceLines = new Set();
  const sinkLines = new Set();
  function walkExpr(expr) {
    if (!expr) return;
    if (expr.type === 'Member') {
      const path = pathOf(expr);
      if (path && (SOURCES.some((s) => path === s || path.startsWith(s + '.')) || SINK_MEMBER_PROPS.includes(expr.property))) {
        if (SINK_MEMBER_PROPS.includes(expr.property)) sinkLines.add(expr.line); else sourceLines.add(expr.line);
      }
      walkExpr(expr.object);
    } else if (expr.type === 'Call') {
      const path = pathOf(expr.callee);
      if (path && SINK_CALLS.some((s) => path === s || path.endsWith('.' + s))) sinkLines.add(expr.line);
      if (path && SOURCE_FNS.includes(path)) sourceLines.add(expr.line);
      walkExpr(expr.callee);
      for (const a of expr.args) walkExpr(a);
    } else if (expr.type === 'Binary') { walkExpr(expr.left); walkExpr(expr.right); }
    else if (expr.type === 'Unary') { walkExpr(expr.arg); }
  }
  function pathOf(e) {
    if (e.type === 'Identifier') return e.name;
    if (e.type === 'Member') { const b = pathOf(e.object); return b === null ? null : `${b}.${e.property}`; }
    return null;
  }
  function walkStmt(stmt) {
    switch (stmt.type) {
      case 'VarDecl': walkExpr(stmt.init); break;
      case 'Assign': walkExpr(stmt.value); walkExpr(stmt.target); break;
      case 'ExprStmt': walkExpr(stmt.expr); break;
      case 'Return': walkExpr(stmt.value); break;
      case 'If': stmt.cons.forEach(walkStmt); (stmt.alt || []).forEach(walkStmt); walkExpr(stmt.test); break;
      case 'While': stmt.body.forEach(walkStmt); walkExpr(stmt.test); break;
      case 'Block': stmt.body.forEach(walkStmt); break;
      case 'FunctionDecl': stmt.body.forEach(walkStmt); break;
    }
  }
  program.body.forEach(walkStmt);
  return { sourceLines, sinkLines };
}

function runAnalysis() {
  parseErrorBox.hidden = true;
  clearGutter();
  state.activeFindingIdx = null;

  let program;
  try {
    program = parse(codeInput.value);
  } catch (err) {
    if (err instanceof ParseError) {
      parseErrorBox.hidden = false;
      parseErrorBox.textContent = `Parse error: ${err.message}`;
      cfgContainer.innerHTML = '';
      findingsList.innerHTML = '';
      statsGrid.innerHTML = '';
      return;
    }
    throw err;
  }

  const cfg = buildCFG(program);
  const { sourceLines, sinkLines } = collectLinesByKind(program);
  markGutter('is-source', sourceLines);
  markGutter('is-sink', sinkLines);

  state.mode = analysisSelect.value;
  state.cfg = cfg;

  if (state.mode === 'taint') {
    const result = runTaintAnalysis(cfg);
    state.taint = result;
    state.reaching = null;
    renderTaintFindings(result);
    renderStats(result.stats, program);
    renderStepper(result);
    renderCFG(cfg, result, null);
  } else {
    const result = reachingDefinitions(cfg);
    state.reaching = result;
    state.taint = null;
    renderReachingFindings(result, cfg);
    renderStats({ blocks: cfg.blocks.length, iterations: result.iterations, timeMs: 0 }, program);
    renderStepper(null);
    renderCFG(cfg, null, result);
  }
}

analyzeBtn.addEventListener('click', runAnalysis);
analysisSelect.addEventListener('change', runAnalysis);

// ------------------------------------------------------------- findings ---

function renderTaintFindings(result) {
  findingsHeading.textContent = 'Findings';
  findingsBlurb.textContent = 'Sinks that receive tainted data without passing through a sanitizer first. Click a finding to highlight its witness path.';
  findingsList.innerHTML = '';
  if (result.findings.length === 0) {
    findingsList.innerHTML = `<p class="note">No findings. Every path from a source to a sink passes through a sanitizer, or no source reaches a sink at all.</p>`;
    return;
  }
  result.findings.forEach((finding, idx) => {
    const div = document.createElement('div');
    div.className = 'finding';
    div.tabIndex = 0;
    div.innerHTML = `
      <div class="row" style="justify-content:space-between;">
        <span class="tag bad">sink</span>
        <span class="faint mono">line ${finding.sinkLine}</span>
      </div>
      <p class="finding-msg">${escapeHtml(finding.message)}</p>
      <p class="faint mono">${finding.path.length} step witness path</p>
    `;
    div.addEventListener('click', () => selectFinding(idx));
    findingsList.appendChild(div);
  });
}

function renderReachingFindings(result, cfg) {
  findingsHeading.textContent = 'Definitions';
  findingsBlurb.textContent = 'Every assignment site (a "definition"), and which blocks it can still reach without being overwritten.';
  findingsList.innerHTML = '';
  if (result.defs.length === 0) {
    findingsList.innerHTML = `<p class="note">No assignments in this program.</p>`;
    return;
  }
  for (const def of result.defs) {
    const reachingBlocks = cfg.blocks.filter((b) => result.final[b.id].in.includes(def.id)).map((b) => b.id);
    const div = document.createElement('div');
    div.className = 'finding';
    div.innerHTML = `
      <div class="row" style="justify-content:space-between;">
        <span class="tag">def #${def.id}</span>
        <span class="faint mono">line ${def.line}</span>
      </div>
      <p class="finding-msg"><code class="inline">${escapeHtml(def.name)}</code> defined here, block ${def.blockId}</p>
      <p class="faint mono">reaches IN of block(s): ${reachingBlocks.length ? reachingBlocks.join(', ') : '(none)'}</p>
    `;
    findingsList.appendChild(div);
  }
}

function selectFinding(idx) {
  state.activeFindingIdx = idx;
  clearGutter();
  const finding = state.taint.findings[idx];
  const { sourceLines, sinkLines } = { sourceLines: [finding.sourceLine], sinkLines: [finding.sinkLine] };
  markGutter('is-source', sourceLines);
  markGutter('is-sink', sinkLines);
  markGutter('is-witness', finding.path.map((p) => p.line));
  [...findingsList.children].forEach((el, i) => el.classList.toggle('active', i === idx));
  renderCFG(state.cfg, state.taint, null);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------------ CFG ---

function blockStateLabel(block, taintResult) {
  if (!taintResult) return { label: '', cls: '' };
  const out = taintResult.final[block.id]?.out ?? [];
  if (out.length === 0) return { label: 'clean', cls: 'clean' };
  return { label: `tainted: ${out.join(', ')}`, cls: 'tainted' };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const BLOCK_W = 190;
const BLOCK_H = 78;

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function renderCFG(cfg, taintResult, reachingResult) {
  const { positions, backEdges, rows, cols } = layoutCFG(cfg);
  const rowH = 130;
  // Size the graph to the container's actual width instead of a fixed
  // 400x190 — a column is at least 210px, but stretches to fill whatever
  // room the panel gives it so there's no dead area on a wide screen.
  const available = cfgContainer.clientWidth || 1100;
  const colW = Math.max(210, Math.min(300, Math.floor((available - 40) / cols)));
  const width = Math.max(cols * colW + 40, available);
  const height = rows * rowH + 60;

  const witnessLines = taintResult && state.activeFindingIdx !== null
    ? new Set(taintResult.findings[state.activeFindingIdx].path.map((p) => p.line))
    : null;

  const centerOf = (id) => {
    const p = positions.get(id);
    const totalWidthForRow = colW * p.rowCount;
    const startX = (width - totalWidthForRow) / 2;
    const x = startX + p.col * colW + colW / 2;
    const y = 30 + p.row * rowH + 40;
    return { x, y };
  };

  const svg = svgEl('svg', {
    width: '100%',
    height,
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMinYMin meet',
  });

  const defs = svgEl('defs');
  defs.innerHTML = `<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--text-faint)"/></marker>
    <marker id="arrow-witness" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--accent)"/></marker>`;
  svg.appendChild(defs);

  const edgeLayer = svgEl('g', { class: 'cfg-edges' });
  const nodeLayer = svgEl('g', { class: 'cfg-nodes' });

  for (const block of cfg.blocks) {
    const from = centerOf(block.id);
    for (const succId of block.succs) {
      const to = centerOf(succId);
      const isBack = backEdges.has(`${block.id}->${succId}`);
      const isWitness = witnessLines && blockOnWitnessPath(cfg, block.id, succId, witnessLines);
      const d = isBack
        ? `M${from.x - 40},${from.y} C${from.x - 100},${from.y - 60} ${to.x - 100},${to.y + 60} ${to.x - 40},${to.y}`
        : `M${from.x},${from.y + BLOCK_H / 2} C${from.x},${from.y + BLOCK_H / 2 + 34} ${to.x},${to.y - BLOCK_H / 2 - 34} ${to.x},${to.y - BLOCK_H / 2}`;
      edgeLayer.appendChild(svgEl('path', {
        d,
        fill: 'none',
        stroke: isWitness ? 'var(--accent)' : 'var(--border-strong)',
        'stroke-width': isWitness ? 2.5 : 1.5,
        'marker-end': `url(#${isWitness ? 'arrow-witness' : 'arrow'})`,
        class: isWitness ? 'cfg-edge on-witness' : 'cfg-edge',
      }));
    }
  }

  for (const block of cfg.blocks) {
    const { x, y } = centerOf(block.id);
    const st = blockStateLabel(block, taintResult);
    const isEntry = block.id === cfg.entry;
    let cls = 'cfg-node';
    if (taintResult) cls += st.cls ? ` ${st.cls}` : '';
    if (reachingResult) cls += ' rd';
    if (witnessLines && block.stmts.some((s) => witnessLines.has(s.line))) cls += ' on-witness';
    const stmtLines = block.stmts.map((s) => `L${s.line} ${s.type}`).join(', ') || '(empty)';
    const headText = `block ${block.id}${isEntry ? ' · entry' : ''}${block.kind === 'loop-header' ? ' · loop' : ''}`;

    const g = svgEl('g', { class: cls, transform: `translate(${x - BLOCK_W / 2}, ${y - BLOCK_H / 2})` });
    g.appendChild(svgEl('rect', { class: 'cfg-node-box', width: BLOCK_W, height: BLOCK_H, rx: 6 }));
    const head = svgEl('text', { class: 'cfg-node-head', x: 10, y: 18 });
    head.textContent = headText;
    g.appendChild(head);
    const lines = svgEl('text', { class: 'cfg-node-lines', x: 10, y: 36 });
    lines.textContent = truncate(stmtLines, 34);
    g.appendChild(lines);
    if (taintResult) {
      const stateText = svgEl('text', { class: 'cfg-node-state', x: 10, y: 58 });
      stateText.textContent = truncate(st.label || 'clean', 36);
      g.appendChild(stateText);
    }
    nodeLayer.appendChild(g);
  }

  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  cfgContainer.innerHTML = '';
  cfgContainer.appendChild(svg);

  cfgLegend.innerHTML = taintResult
    ? `<span class="tag">clean block</span><span class="tag bad">tainted block</span><span class="tag" style="border-color:var(--accent);color:var(--accent);">witness edge</span>`
    : `<span class="tag">reaching-definitions block (see def IDs in the findings panel)</span>`;
}

function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function blockOnWitnessPath(cfg, fromId, toId, witnessLines) {
  const from = cfg.blocks.find((b) => b.id === fromId);
  const to = cfg.blocks.find((b) => b.id === toId);
  return from.stmts.some((s) => witnessLines.has(s.line)) && to.stmts.some((s) => witnessLines.has(s.line));
}

// -------------------------------------------------------------- stepper ---

function renderStepper(taintResult) {
  state.stepIdx = 0;
  if (!taintResult || taintResult.history.length === 0) {
    stepSlider.max = 0;
    stepSlider.value = 0;
    stepCounter.textContent = '';
    stepDetail.innerHTML = '<p class="faint">No worklist steps (select the taint analysis to see the stepper).</p>';
    updateStepButtons();
    return;
  }
  stepSlider.max = String(taintResult.history.length - 1);
  stepSlider.value = '0';
  updateStepView();
}

function updateStepView() {
  const history = state.taint?.history;
  if (!history || history.length === 0) return;
  const entry = history[state.stepIdx];
  stepCounter.textContent = `step ${state.stepIdx + 1} / ${history.length} · total iterations to fixed point: ${state.taint.stats.iterations}`;
  stepDetail.innerHTML = `
    <div class="row" style="justify-content:space-between;">
      <span class="tag ${entry.changed ? 'warn' : ''}">block ${entry.blockId}</span>
      <span class="faint mono">${entry.changed ? 'OUT changed — successors re-queued' : 'OUT unchanged — nothing re-queued'}</span>
    </div>
    <div class="grid two" style="margin-top:.6rem;">
      <div>
        <label>IN (joined from predecessors)</label>
        <p class="mono">${entry.in.length ? entry.in.join(', ') : '∅'}</p>
      </div>
      <div>
        <label>OUT (after transfer function)</label>
        <p class="mono">${entry.out.length ? entry.out.join(', ') : '∅'}</p>
      </div>
    </div>
  `;
  stepSlider.value = String(state.stepIdx);
  updateStepButtons();
}

function updateStepButtons() {
  const history = state.taint?.history ?? [];
  stepPrevBtn.disabled = state.stepIdx <= 0;
  stepFirstBtn.disabled = state.stepIdx <= 0;
  stepNextBtn.disabled = state.stepIdx >= history.length - 1;
  stepLastBtn.disabled = state.stepIdx >= history.length - 1;
}

stepFirstBtn.addEventListener('click', () => { state.stepIdx = 0; updateStepView(); });
stepPrevBtn.addEventListener('click', () => { state.stepIdx = Math.max(0, state.stepIdx - 1); updateStepView(); });
stepNextBtn.addEventListener('click', () => {
  const max = (state.taint?.history.length ?? 1) - 1;
  state.stepIdx = Math.min(max, state.stepIdx + 1);
  updateStepView();
});
stepLastBtn.addEventListener('click', () => { state.stepIdx = (state.taint?.history.length ?? 1) - 1; updateStepView(); });
stepSlider.addEventListener('input', () => { state.stepIdx = Number(stepSlider.value); updateStepView(); });

// ------------------------------------------------------------------ stats ---

function renderStats(stats, program) {
  const lines = codeInput.value.split('\n').length;
  statsGrid.innerHTML = `
    <div class="stat"><span class="value">${lines}</span><span class="label">source lines</span></div>
    <div class="stat"><span class="value">${stats.blocks}</span><span class="label">CFG blocks</span></div>
    <div class="stat"><span class="value">${stats.iterations}</span><span class="label">worklist steps to fixed point</span></div>
  `;
}

// -------------------------------------------------------------- benchmark ---

function runBenchmark() {
  benchStatus.textContent = 'running…';
  requestAnimationFrame(() => {
    const points = EXAMPLES.map((ex) => {
      const program = parse(ex.code);
      const cfg = buildCFG(program);
      const t0 = performance.now();
      const result = runTaintAnalysis(cfg);
      const t1 = performance.now();
      return {
        label: ex.id,
        lines: ex.code.split('\n').length,
        blocks: cfg.blocks.length,
        iterations: result.stats.iterations,
        timeMs: t1 - t0,
      };
    });
    drawBenchChart(points);
    benchStatus.textContent = `measured ${points.length} examples just now`;
  });
}
runBenchmarkBtn.addEventListener('click', runBenchmark);

function drawBenchChart(points) {
  const ctx = benchCanvas.getContext('2d');
  const w = benchCanvas.width, h = benchCanvas.height;
  ctx.clearRect(0, 0, w, h);
  const style = getComputedStyle(document.documentElement);
  const textDim = style.getPropertyValue('--text-dim').trim();
  const accent = style.getPropertyValue('--accent').trim();
  const border = style.getPropertyValue('--border').trim();

  const padL = 40, padB = 50, padT = 20, padR = 20;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const maxLines = Math.max(...points.map((p) => p.lines), 1);
  const maxIter = Math.max(...points.map((p) => p.iterations), 1);

  ctx.strokeStyle = border;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  ctx.fillStyle = textDim;
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillText('iterations to fixed point', padL, padT - 6);
  ctx.fillText('program size (lines)', padL + plotW - 130, h - 10);

  // Labels drawn inline collide once points sit close together (small
  // example set, similar sizes/iteration counts). Number the markers
  // instead and key the numbers in a legend under the chart.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  points.forEach((p, i) => {
    const x = padL + (p.lines / maxLines) * plotW * 0.9 + 10;
    const y = padT + plotH - (p.iterations / maxIter) * plotH * 0.85 - 5;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#07101f';
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.fillText(String(i + 1), x, y + 1);
  });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  benchLegend.innerHTML = points
    .map((p, i) => `<span class="tag"><strong>${i + 1}</strong> ${escapeHtml(p.label)}</span>`)
    .join('');
}

// ------------------------------------------------------------------- init ---

function init() {
  const example = EXAMPLES.find((e) => e.id === DEFAULT_EXAMPLE_ID);
  codeInput.value = example.code;
  renderGutterSkeleton();
  runAnalysis();
}
init();
