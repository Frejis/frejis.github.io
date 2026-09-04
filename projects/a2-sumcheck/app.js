// DOM and canvas only. Every number on the page comes from sumcheck.js.

import {
  P,
  PRESETS,
  CHEATS,
  makeRng,
  makePolynomial,
  runProtocol,
  soundnessExperiment,
  benchmarkOne,
} from './sumcheck.js';

const $ = (id) => document.getElementById(id);

const el = {
  v: $('v-input'),
  vOut: $('v-out'),
  preset: $('preset-input'),
  presetBlurb: $('preset-blurb'),
  cheat: $('cheat-input'),
  next: $('next-btn'),
  auto: $('auto-btn'),
  reset: $('reset-btn'),

  stepTag: $('step-tag'),
  stepTitle: $('step-title'),
  narration: $('narration'),
  claimBlock: $('claim-block'),
  claimedSum: $('claimed-sum'),
  trueSum: $('true-sum'),
  tableSize: $('table-size'),

  roundBlock: $('round-block'),
  polyCoeffs: $('poly-coeffs'),
  s0: $('s0'),
  s1: $('s1'),
  challenge: $('challenge'),
  checkEq: $('check-eq'),
  verdict: $('verdict'),
  verdictNote: $('verdict-note'),

  finalBlock: $('final-block'),
  finalEq: $('final-eq'),
  finalVerdict: $('final-verdict'),
  finalNote: $('final-note'),

  proverOps: $('prover-ops'),
  verifierOps: $('verifier-ops'),
  proverBar: $('prover-bar'),
  verifierBar: $('verifier-bar'),
  opsRatio: $('ops-ratio'),

  cube: $('cube'),
  cubeTitle: $('cube-title'),
  cubeSub: $('cube-sub'),

  experimentBtn: $('experiment-btn'),
  experimentStatus: $('experiment-status'),
  expRate: $('exp-rate'),
  expEscaped: $('exp-escaped'),
  expBound: $('exp-bound'),
  experimentNote: $('experiment-note'),

  benchBtn: $('bench-btn'),
  benchStatus: $('bench-status'),
  benchHeadline: $('bench-headline'),
  benchChart: $('bench-chart'),
  benchTable: $('bench-table'),
};

const state = {
  table: [],
  run: null,
  step: 0, // 0 = the claim, 1..v = rounds, v+1 = the oracle query
  timer: null,
  seed: 1,
};

// ---------------------------------------------------------------- formatting

const groups = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
const fmt = (x) => groups(x.toString());
const fmtShort = (x) => {
  const s = x.toString();
  return s.length > 7 ? `${s.slice(0, 6)}\u2026` : s;
};
const plural = (n, word) => `${groups(String(n))} ${word}${n === 1 ? '' : 's'}`;

function ms(x) {
  if (x >= 100) return `${x.toFixed(0)} ms`;
  if (x >= 1) return `${x.toFixed(1)} ms`;
  if (x >= 0.001) return `${x.toFixed(3)} ms`;
  return `${x.toExponential(1)} ms`;
}

// ------------------------------------------------------------------- startup

for (const p of PRESETS) {
  el.preset.append(new Option(p.name, p.id));
}
for (const c of CHEATS) {
  el.cheat.append(new Option(c.name, c.id));
}

el.v.addEventListener('input', () => {
  el.vOut.value = el.v.value;
  rebuild();
});
el.preset.addEventListener('change', rebuild);
el.cheat.addEventListener('change', rebuild);
el.next.addEventListener('click', () => {
  stopAuto();
  advance();
});
el.auto.addEventListener('click', toggleAuto);
el.reset.addEventListener('click', () => {
  stopAuto();
  state.seed++;
  rebuild();
});
el.experimentBtn.addEventListener('click', runExperiment);
el.benchBtn.addEventListener('click', runBenchmark);

function rebuild() {
  const v = Number(el.v.value);
  const preset = el.preset.value;
  state.table = makePolynomial(preset, v, makeRng(state.seed * 7919 + v));
  state.run = runProtocol({
    table: state.table,
    cheat: el.cheat.value,
    cheatRound: 1 + ((state.seed + v) % v),
    rng: makeRng(state.seed * 104729 + 13),
    delta: 1n + BigInt(state.seed),
  });
  state.step = 0;
  el.presetBlurb.textContent = PRESETS.find((p) => p.id === preset).blurb;
  render();
}

function advance() {
  const last = state.run.v + 1;
  if (state.step < last) state.step++;
  render();
}

function toggleAuto() {
  if (state.timer) return stopAuto();
  el.auto.textContent = 'Pause';
  state.timer = setInterval(() => {
    if (state.step >= state.run.v + 1) return stopAuto();
    advance();
  }, 1100);
  advance();
}

function stopAuto() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  el.auto.textContent = 'Auto-play';
}

// -------------------------------------------------------------------- render

function render() {
  const run = state.run;
  const step = state.step;
  const last = run.v + 1;

  el.stepTag.textContent = step === 0 ? 'the claim' : step === last ? 'final check' : `round ${step} of ${run.v}`;
  el.next.disabled = step >= last;
  if (step >= last) stopAuto();

  el.claimedSum.textContent = fmt(run.claimedSum);
  el.trueSum.textContent = run.cheat === 'none' ? fmt(run.trueSum) : `${fmt(run.trueSum)}  (the prover is off by ${fmt(run.claimedSum >= run.trueSum ? run.claimedSum - run.trueSum : P - run.trueSum + run.claimedSum)})`;
  el.claimedSum.classList.toggle('changed', run.cheat !== 'none');
  el.tableSize.textContent = `2^${run.v} = ${groups(String(run.size))}`;

  el.roundBlock.hidden = step === 0 || step === last;
  el.finalBlock.hidden = step !== last;

  if (step === 0) renderClaim(run);
  else if (step === last) renderFinal(run);
  else renderRound(run, run.rounds[step - 1]);

  renderCube(run, step);
  renderOps(run, step);
}

function renderClaim(run) {
  el.stepTitle.textContent = 'The claim';
  const cheatLine =
    run.cheat === 'sum'
      ? 'This prover is lying: the total it states is not the total of the table. It will now have to keep the story straight for every round.'
      : run.cheat === 'round'
        ? `This prover states the correct total, but intends to corrupt round ${run.cheatRound} in a way that still passes that round's check.`
        : 'The verifier could add up the table itself, but that is exactly the work it is trying to avoid.';
  el.narration.textContent = `The prover claims the ${groups(String(run.size))} values sum to ${fmt(run.claimedSum)}. ${cheatLine}`;
}

function renderRound(run, rd) {
  el.stepTitle.textContent = `Round ${rd.index}: fixing ${rd.variable}`;

  const a = rd.coeffs.a;
  const b = rd.coeffs.b;
  el.polyCoeffs.textContent = `s(X) = ${fmt(b)} + ${fmt(a)}\u00b7X`;
  el.s0.textContent = fmt(rd.s0);
  el.s1.textContent = fmt(rd.s1);
  el.challenge.textContent = fmt(rd.r);

  const source = rd.index === 1 ? 'H' : `s${rd.index - 1}(r${rd.index - 1})`;
  el.checkEq.textContent =
    `s${rd.index}(0) + s${rd.index}(1)  =?  ${source}\n` +
    `${fmt(rd.s0)} + ${fmt(rd.s1)}  =?  ${fmt(rd.claim)}\n` +
    `${fmt(rd.check.lhs)}  ${rd.check.ok ? '=' : '\u2260'}  ${fmt(rd.check.rhs)}`;

  el.verdict.textContent = rd.check.ok ? 'check passes' : 'check fails';
  el.verdict.className = `tag ${rd.check.ok ? 'good' : 'bad'}`;
  el.verdictNote.textContent = rd.check.ok
    ? `verifier cost this round: 4 field operations`
    : `the prover cannot make this round add up`;

  const halfCount = groups(String(rd.half));
  const unseen = run.size - 1;
  if (!rd.check.ok) {
    el.narration.textContent =
      `The two halves do not add up to what was promised. The verifier rejects immediately, having read ${plural(2, 'number')}.`;
  } else if (rd.tampered) {
    el.narration.textContent =
      `The prover has doctored this round so the arithmetic still balances. It passes. But it has now committed to a polynomial that does not match the real table, and it does not yet know which point r the verifier will pick.`;
  } else if (rd.index === 1) {
    el.narration.textContent =
      `The prover splits the table in two: ${halfCount} values where ${rd.variable} = 0, ${halfCount} where ${rd.variable} = 1. The verifier adds those two numbers and gets the claimed total. It has never seen the other ${groups(String(unseen))} values.`;
  } else {
    el.narration.textContent =
      `${rd.variable} is now the live variable and ${rd.index - 1} earlier variables are pinned to random field elements. The verifier checks one addition, picks r = ${fmtShort(rd.r)}, and the table the prover is working over halves again to ${halfCount} entries.`;
  }
}

function renderFinal(run) {
  el.stepTitle.textContent = 'The one query the verifier makes';
  const f = run.final;
  el.finalEq.textContent =
    `g(${f.point.map(fmtShort).join(', ')})\n` +
    `  =  ${fmt(f.oracleValue)}\n` +
    `s${run.v}(r${run.v}) = ${fmt(f.expected)}\n` +
    `  ${f.ok ? '=' : '\u2260'}  ${f.ok ? 'accept' : 'reject'}`;
  el.finalVerdict.textContent = run.accepted ? 'accepted' : 'rejected';
  el.finalVerdict.className = `tag ${run.accepted ? 'good' : 'bad'}`;
  el.finalNote.textContent = run.accepted
    ? 'the prover was telling the truth, or got astronomically lucky'
    : 'the lie surfaces here, at the one point the prover could not predict';

  if (run.accepted && run.cheat === 'none') {
    el.narration.textContent =
      `One evaluation of g at a random point, and the verifier is convinced of a sum over ${groups(String(run.size))} values. It touched ${plural(run.ops.verifier, 'field operation')} against the prover's ${groups(String(run.ops.prover))}.`;
  } else {
    el.narration.textContent =
      `Every individual round balanced, so the cheating prover survived to the end. Then the verifier asked for g at a point nobody could have guessed, and the story fell apart. To get away with it the prover needed the challenge to hit one of at most ${run.v} bad points out of ${fmt(P)}.`;
  }
}

// ---------------------------------------------------------------- cube panel

function renderCube(run, step) {
  const last = run.v + 1;
  const cube = el.cube;
  cube.textContent = '';

  if (step === last) {
    cube.className = 'cube';
    cube.style.gridTemplateColumns = 'minmax(0, 220px)';
    el.cubeTitle.textContent = 'One point left';
    el.cubeSub.textContent = `${groups(String(run.size))} values collapsed to 1`;
    const c = document.createElement('div');
    c.className = 'cell folded';
    c.innerHTML = `<div class="bits">g(r1..r${run.v})</div><div class="val">${fmt(run.final.oracleValue)}</div>`;
    cube.append(c);
    return;
  }

  const rd = run.rounds[Math.max(0, step - 1)];
  const table = rd.table;
  const fixed = step === 0 ? 0 : rd.index - 1;
  const liveVar = step === 0 ? 1 : rd.index;
  const m = run.v - fixed; // live boolean variables
  const dense = table.length > 128;

  // A power-of-two column count so the x = 0 half fills whole rows and the
  // split the verifier is about to check is visible as a horizontal line.
  const cols = Math.min(1 << Math.ceil(m / 2), dense ? 64 : 8);
  cube.className = dense ? 'cube dense' : 'cube';
  cube.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  el.cubeTitle.textContent = fixed === 0 ? 'The hypercube' : `The hypercube, ${fixed} variable${fixed === 1 ? '' : 's'} fixed`;
  el.cubeSub.textContent = `${groups(String(table.length))} cells\u2002·\u2002x${liveVar} splits them in half`;

  const half = table.length >> 1;
  const max = table.reduce((a, x) => (x > a ? x : a), 1n);

  const frag = document.createDocumentFragment();
  for (let i = 0; i < table.length; i++) {
    const c = document.createElement('div');
    c.className = `cell ${i < half ? 'half-zero' : 'half-one'}`;
    const bits = [];
    for (let b = m - 1; b >= 0; b--) bits.push((i >> b) & 1);
    const label = fixed ? `r\u00b7${fixed} | ${bits.join('')}` : bits.join('');
    if (dense) {
      const t = Number((table[i] * 100n) / max) / 100;
      c.style.background = `color-mix(in srgb, ${i < half ? 'var(--accent)' : 'var(--alt)'} ${8 + t * 80}%, var(--bg-inset))`;
      c.title = `${label} \u2192 ${table[i]}`;
    } else {
      c.title = `${label} \u2192 ${table[i]}`;
      c.innerHTML = `<div class="bits">${label}</div><div class="val">${fmtShort(table[i])}</div>`;
    }
    frag.append(c);
  }
  cube.append(frag);
}

// ----------------------------------------------------------------- work bars

function renderOps(run, step) {
  const ops = step === 0 ? { prover: run.size - 1, verifier: 0 } : run.rounds[Math.min(step, run.v) - 1].ops;
  const prover = step === run.v + 1 ? run.ops.prover : ops.prover;
  const verifier = step === run.v + 1 ? run.ops.verifier : ops.verifier;
  const scale = Math.max(prover, 1);

  el.proverOps.textContent = groups(String(prover));
  el.verifierOps.textContent = groups(String(verifier));
  el.proverBar.style.width = '100%';
  el.verifierBar.style.width = `${(verifier / scale) * 100}%`;
  el.opsRatio.textContent = verifier
    ? `The prover has done ${(prover / verifier).toFixed(0)}x the verifier's arithmetic. The gap widens with every extra variable, because the prover's work doubles and the verifier's grows by four operations.`
    : 'The verifier has not done any arithmetic yet.';
}

// --------------------------------------------------------------- experiments

function runExperiment() {
  el.experimentBtn.disabled = true;
  el.experimentStatus.textContent = 'running...';
  setTimeout(() => {
    const v = Number(el.v.value);
    const t0 = performance.now();
    const r = soundnessExperiment({ v, trials: 200, preset: el.preset.value, cheat: 'sum', seed: state.seed + 1 });
    const dt = performance.now() - t0;

    el.expRate.textContent = `${(r.rate * 100).toFixed(1)}%`;
    el.expRate.style.color = r.rate === 1 ? 'var(--good)' : 'var(--warn)';
    el.expEscaped.textContent = `${r.escaped} / ${r.trials}`;
    el.expBound.textContent = r.bound.toExponential(2);
    el.experimentStatus.textContent = `${r.trials} runs at v = ${v} in ${ms(dt)}`;
    el.experimentNote.textContent =
      `Every one of the ${r.trials} cheating provers was caught. The theory allows an escape probability of at most ${r.bound.toExponential(2)}: about 1 in ${groups(String(Math.round(1 / r.bound)))} attempts, so seeing zero escapes in ${r.trials} runs is exactly what it predicts. A larger field makes the bound smaller; this one is small on purpose so the numbers stay readable.`;
    el.experimentBtn.disabled = false;
  }, 20);
}

// ----------------------------------------------------------------- benchmark

const BENCH_VS = [4, 6, 8, 10, 12, 14, 16, 17, 18];

function runBenchmark() {
  el.benchBtn.disabled = true;
  const rows = [];
  let i = 0;

  const stepOne = () => {
    if (i >= BENCH_VS.length) {
      el.benchStatus.textContent = `${rows.length} sizes measured, up to 2^${rows.at(-1).v} values`;
      el.benchBtn.disabled = false;
      finishBenchmark(rows);
      return;
    }
    const v = BENCH_VS[i++];
    el.benchStatus.textContent = `measuring v = ${v} (${groups(String(2 ** v))} values)...`;
    setTimeout(() => {
      rows.push(benchmarkOne(v, () => performance.now(), { verifierRepeats: 500 }));
      drawChart(rows);
      stepOne();
    }, 0);
  };
  stepOne();
}

function finishBenchmark(rows) {
  const big = rows.at(-1);
  const factor = big.naiveMs / big.verifierMs;
  el.benchHeadline.hidden = false;
  el.benchHeadline.textContent =
    `At v = ${big.v} the naive sum over ${groups(String(big.size))} values took ${ms(big.naiveMs)} and the prover ${ms(big.proverMs)}. ` +
    `The verifier spent ${ms(big.verifierMs)} to be convinced of the same number: ${groups(String(Math.round(factor)))} times less than doing the sum itself, ` +
    `and it read ${plural(big.verifierOps, 'field operation')} instead of ${groups(String(big.proverOps))}.`;

  const tb = el.benchTable.querySelector('tbody');
  tb.textContent = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="mono">${r.v}</td><td class="num">${groups(String(r.size))}</td>` +
      `<td class="num">${r.naiveMs.toFixed(2)}</td><td class="num">${r.proverMs.toFixed(2)}</td>` +
      `<td class="num">${r.verifierMs.toFixed(4)}</td>` +
      `<td class="num">${groups(String(r.proverOps))}</td><td class="num">${groups(String(r.verifierOps))}</td>`;
    tb.append(tr);
  }
  el.benchTable.hidden = false;
}

function drawChart(rows) {
  const cv = el.benchChart;
  const ctx = cv.getContext('2d');
  const css = getComputedStyle(document.body);
  const c = (name) => css.getPropertyValue(name).trim();

  const pad = { l: 72, r: 150, t: 24, b: 46 };
  const W = cv.width;
  const H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (!rows.length) return;

  const values = rows.flatMap((r) => [r.naiveMs, r.proverMs, r.verifierMs]).filter((x) => x > 0);
  const lo = Math.min(...values, 0.001);
  const hi = Math.max(...values);
  const ylo = Math.log10(lo) - 0.2;
  const yhi = Math.log10(hi) + 0.2;
  const xs = (v) => pad.l + ((v - BENCH_VS[0]) / (BENCH_VS.at(-1) - BENCH_VS[0])) * (W - pad.l - pad.r);
  const ys = (t) => pad.t + (1 - (Math.log10(Math.max(t, lo)) - ylo) / (yhi - ylo)) * (H - pad.t - pad.b);

  // grid: one line per decade
  ctx.font = '12px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  for (let e = Math.floor(ylo); e <= Math.ceil(yhi); e++) {
    const y = ys(10 ** e);
    if (y < pad.t || y > H - pad.b) continue;
    ctx.strokeStyle = c('--border');
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = c('--text-faint');
    ctx.textAlign = 'right';
    ctx.fillText(e >= 0 ? `${10 ** e} ms` : `${(10 ** e).toFixed(-e)} ms`, pad.l - 10, y);
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = c('--text-faint');
  for (const r of rows) ctx.fillText(`2^${r.v}`, xs(r.v), H - pad.b + 18);
  ctx.fillText('values summed', (pad.l + W - pad.r) / 2, H - 8);

  const series = [
    { key: 'naiveMs', label: 'naive sum', colour: c('--warn') },
    { key: 'proverMs', label: 'prover', colour: c('--alt') },
    { key: 'verifierMs', label: 'verifier', colour: c('--good') },
  ];

  for (const s of series) {
    ctx.strokeStyle = s.colour;
    ctx.fillStyle = s.colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    rows.forEach((r, i) => {
      const x = xs(r.v);
      const y = ys(r[s.key]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    for (const r of rows) {
      ctx.beginPath();
      ctx.arc(xs(r.v), ys(r[s.key]), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const lastRow = rows.at(-1);
    ctx.textAlign = 'left';
    ctx.fillText(s.label, xs(lastRow.v) + 10, ys(lastRow[s.key]));
  }
}

// go
el.vOut.value = el.v.value;
rebuild();
