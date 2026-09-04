// DOM and canvas only. All engine logic lives in pbt.js, all subjects in
// subjects.js. This file just wires them to the page.

import { check, benchmarkTimeToFailure, estimateSize } from "./pbt.js";
import { subjects, getSubject } from "./subjects.js";

const $ = (id) => document.getElementById(id);

const el = {
  subjectSelect: $("subject-select"),
  subjectDesc: $("subject-desc"),
  runsInput: $("runs-input"),
  seedInput: $("seed-input"),
  runBtn: $("run-btn"),
  rerunBtn: $("rerun-btn"),

  runTag: $("run-tag"),
  passCount: $("pass-count"),
  failCount: $("fail-count"),
  seedEcho: $("seed-echo"),
  runStrip: $("run-strip"),
  runNote: $("run-note"),

  resultSection: $("result-section"),
  originalValue: $("original-value"),
  originalSize: $("original-size"),
  minimalValue: $("minimal-value"),
  minimalSize: $("minimal-size"),
  reductionNote: $("reduction-note"),

  shrinkSection: $("shrink-section"),
  shrinkStepCount: $("shrink-step-count"),
  shrinkChart: $("shrink-chart"),
  shrinkTbody: $("shrink-tbody"),

  distChart: $("dist-chart"),
  distNote: $("dist-note"),

  benchBtn: $("bench-btn"),
  benchStatus: $("bench-status"),
  benchChart: $("bench-chart"),
  benchNote: $("bench-note"),
};

const state = {
  // Default to a buggy subject so the page shows the shrink visualisation -
  // the whole point of this demo - within seconds of opening, unprompted.
  subject: getSubject("sort-lexicographic"),
};

// ------------------------------------------------------------------- startup

for (const s of subjects) {
  const opt = new Option(`${s.name}${s.buggy ? "" : " (correct)"}`, s.id);
  el.subjectSelect.append(opt);
}
el.subjectSelect.value = state.subject.id;

el.subjectSelect.addEventListener("change", () => {
  state.subject = getSubject(el.subjectSelect.value);
  el.subjectDesc.textContent = state.subject.description;
  resetBenchmark();
});
el.runBtn.addEventListener("click", () => runNow({ freshSeed: false }));
el.rerunBtn.addEventListener("click", () => runNow({ freshSeed: false, forceSeed: true }));
el.benchBtn.addEventListener("click", runBenchmark);

el.subjectDesc.textContent = state.subject.description;

// ---------------------------------------------------------------------- fmt

const groups = (s) => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");

function fmtValue(v) {
  if (Array.isArray(v)) return `[${v.map(fmtValue).join(", ")}]`;
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

function fmtValues(values) {
  return values.length === 1 ? fmtValue(values[0]) : values.map(fmtValue).join(", ");
}

// -------------------------------------------------------------------- run

function runNow({ forceSeed }) {
  const runs = Math.max(1, Number(el.runsInput.value) || 200);
  const seed = Number(el.seedInput.value) || 0;

  el.runBtn.disabled = true;
  el.rerunBtn.disabled = true;
  el.runTag.textContent = "running...";
  el.runStrip.innerHTML = "";
  el.passCount.textContent = "0";
  el.failCount.textContent = "0";

  // yield a frame so the "running..." state actually paints before the
  // (synchronous, usually sub-millisecond) run happens
  requestAnimationFrame(() => {
    let passed = 0;
    let failed = 0;
    const result = check(state.subject.property, state.subject.gens, {
      runs,
      seed,
      recordDistribution: true,
      onRun(i, ok) {
        if (ok) passed++;
        else failed++;
        appendStripDot(ok);
      },
    });

    el.seedEcho.textContent = result.seed;
    el.seedInput.value = result.seed;
    el.passCount.textContent = groups(passed);
    el.failCount.textContent = groups(failed);
    el.runTag.textContent = result.passed
      ? `passed all ${groups(result.runsExecuted)} runs`
      : `failed on run ${groups(result.runsExecuted)}`;
    el.runTag.className = `tag ${result.passed ? "good" : "bad"}`;

    if (result.passed) {
      el.runNote.textContent =
        `No counterexample in ${groups(result.runsExecuted)} runs at seed ${result.seed}. ` +
        `That is evidence, not proof: a correct-looking subject could still fail on a seed not tried here.`;
      hideResult();
    } else {
      el.runNote.textContent =
        `Reproduce this exact failure any time with seed ${result.seed} — the run is fully deterministic.`;
      showResult(result);
    }

    drawDistribution(result.distribution ?? []);
    el.runBtn.disabled = false;
    el.rerunBtn.disabled = false;
  });
}

function appendStripDot(ok) {
  const dot = document.createElement("span");
  dot.className = `dot ${ok ? "pass" : "fail"}`;
  el.runStrip.append(dot);
}

// -------------------------------------------------------------- counterexample

function hideResult() {
  el.resultSection.hidden = true;
  el.shrinkSection.hidden = true;
}

function showResult(result) {
  el.resultSection.hidden = false;
  el.originalValue.textContent = fmtValues(result.originalCounterexample);
  el.originalSize.textContent = result.originalSize;
  el.minimalValue.textContent = fmtValues(result.minimalCounterexample);
  el.minimalSize.textContent = result.minimalSize;

  const from = result.originalSize;
  const to = result.minimalSize;
  if (from > 0 && to < from) {
    const pct = Math.round((1 - to / from) * 100);
    el.reductionNote.textContent = `${groups(from)} \u2192 ${groups(to)} in size, ${pct}% smaller, in ${groups(result.shrinkPath.length - 1)} shrink attempts.`;
  } else {
    el.reductionNote.textContent = `Already minimal, or size did not shrink further (${groups(from)} \u2192 ${groups(to)}).`;
  }

  el.shrinkSection.hidden = false;
  el.shrinkStepCount.textContent = `${groups(result.shrinkPath.length)} candidates tried`;
  drawShrinkChart(result.shrinkPath);
  drawShrinkTable(result.shrinkPath);
}

function drawShrinkTable(path) {
  el.shrinkTbody.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const entry of path) {
    const tr = document.createElement("tr");
    tr.className = entry.accepted ? "accepted" : entry.step === 0 ? "" : "rejected";
    const outcome = entry.step === 0 ? "original" : entry.failed ? "still fails" : "passes (dead end)";
    tr.innerHTML =
      `<td class="num mono">${entry.step}</td>` +
      `<td class="mono candidate-cell">${escapeHtml(fmtValues(entry.values))}</td>` +
      `<td class="num mono">${entry.size}</td>` +
      `<td><span class="tag ${entry.step === 0 ? "" : entry.failed ? "bad" : "good"}">${outcome}</span></td>`;
    frag.append(tr);
  }
  el.shrinkTbody.append(frag);
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ------------------------------------------------------------------ charts

function chartColours() {
  const css = getComputedStyle(document.body);
  const c = (name) => css.getPropertyValue(name).trim();
  return {
    border: c("--border"),
    faint: c("--text-faint"),
    dim: c("--text-dim"),
    accent: c("--accent"),
    good: c("--good"),
    bad: c("--bad"),
  };
}

function clearCanvas(cv) {
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  return ctx;
}

// Descending staircase of accepted-candidate size per shrink step, drawn
// progressively (one accepted candidate at a time) so "Watching it shrink"
// is literally true instead of the whole chart snapping in at once.
let shrinkAnimId = 0;

function drawShrinkChart(path) {
  const myAnimId = ++shrinkAnimId; // supersedes any animation already in flight
  const cv = el.shrinkChart;
  const col = chartColours();
  const accepted = path.filter((p) => p.accepted);
  if (accepted.length < 1) { clearCanvas(cv); return; }

  const pad = { l: 56, r: 24, t: 20, b: 34 };
  const W = cv.width, H = cv.height;
  const maxSize = Math.max(1, ...accepted.map((p) => p.size));
  const xs = (i) => pad.l + (accepted.length <= 1 ? 0 : (i / (accepted.length - 1)) * (W - pad.l - pad.r));
  const ys = (size) => pad.t + (1 - size / maxSize) * (H - pad.t - pad.b);

  function drawAxes(ctx) {
    ctx.font = "11px ui-monospace, monospace";
    ctx.strokeStyle = col.border;
    ctx.fillStyle = col.faint;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const size = Math.round((maxSize * t) / ticks);
      const y = ys(size);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(W - pad.r, y);
      ctx.stroke();
      ctx.fillText(String(size), pad.l - 8, y);
    }
    ctx.textAlign = "center";
    ctx.fillText("shrink step \u2192", (pad.l + W - pad.r) / 2, H - 10);
  }

  // Total animation length is capped rather than fixed per-step, so a huge
  // shrink path (hundreds of candidates) doesn't drag on forever.
  const totalMs = Math.min(1400, Math.max(300, accepted.length * 40));
  const msPerStep = totalMs / accepted.length;
  const t0 = performance.now();

  function frame(now) {
    if (myAnimId !== shrinkAnimId) return; // a newer run started, stop
    const elapsed = now - t0;
    const shown = Math.min(accepted.length, 1 + Math.floor(elapsed / msPerStep));

    const ctx = clearCanvas(cv);
    drawAxes(ctx);

    ctx.strokeStyle = col.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < shown; i++) {
      const p = accepted[i];
      const x = xs(i), y = ys(p.size);
      if (i === 0) ctx.moveTo(x, y);
      else {
        const prevY = ys(accepted[i - 1].size);
        ctx.lineTo(x, prevY); // step: hold size, then...
        ctx.lineTo(x, y); //        drop to new size
      }
    }
    ctx.stroke();

    for (let i = 0; i < shown; i++) {
      const p = accepted[i];
      const isLast = i === shown - 1;
      ctx.fillStyle = isLast && shown === accepted.length ? col.good : col.accent;
      ctx.beginPath();
      ctx.arc(xs(i), ys(p.size), isLast ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (shown < accepted.length) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function drawDistribution(sizes) {
  const cv = el.distChart;
  const ctx = clearCanvas(cv);
  const col = chartColours();
  if (sizes.length === 0) {
    el.distNote.textContent = "Run the test above to populate this.";
    return;
  }

  const pad = { l: 44, r: 20, t: 16, b: 34 };
  const W = cv.width, H = cv.height;
  const maxVal = Math.max(1, ...sizes);
  const buckets = Math.min(30, maxVal + 1);
  const bucketWidth = (maxVal + 1) / buckets;
  const counts = new Array(buckets).fill(0);
  for (const s of sizes) counts[Math.min(buckets - 1, Math.floor(s / bucketWidth))]++;
  const maxCount = Math.max(1, ...counts);

  const barW = (W - pad.l - pad.r) / buckets;
  ctx.fillStyle = col.accent;
  counts.forEach((count, i) => {
    const h = (count / maxCount) * (H - pad.t - pad.b);
    ctx.fillRect(pad.l + i * barW + 1, H - pad.b - h, Math.max(1, barW - 2), h);
  });

  ctx.strokeStyle = col.border;
  ctx.beginPath();
  ctx.moveTo(pad.l, H - pad.b);
  ctx.lineTo(W - pad.r, H - pad.b);
  ctx.stroke();

  ctx.fillStyle = col.faint;
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillText("0", pad.l, H - pad.b + 16);
  ctx.textAlign = "right";
  ctx.fillText(String(maxVal), W - pad.r, H - pad.b + 16);
  ctx.textAlign = "center";
  ctx.fillText("generated input size \u2192", (pad.l + W - pad.r) / 2, H - 4);

  el.distNote.textContent = `${groups(sizes.length)} generated inputs, sizes ${Math.min(...sizes)}\u2013${maxVal}.`;
}

// -------------------------------------------------------------- benchmark

function resetBenchmark() {
  el.benchStatus.textContent = "not run yet";
  el.benchNote.textContent = "";
  drawBenchPlaceholder();
}

function drawBenchPlaceholder() {
  const cv = el.benchChart;
  const ctx = clearCanvas(cv);
  const col = chartColours();
  ctx.font = "13px ui-monospace, monospace";
  ctx.fillStyle = col.faint;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("press \u201cRun 200 seeds\u201d to measure", cv.width / 2, cv.height / 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function runBenchmark() {
  el.benchBtn.disabled = true;
  el.benchStatus.textContent = "running...";
  requestAnimationFrame(() => {
    const t0 = performance.now();
    const b = benchmarkTimeToFailure(state.subject.property, state.subject.gens, {
      seeds: 200,
      maxRuns: 300,
    });
    const dt = performance.now() - t0;

    drawBenchChart(b.results.map((r) => r.runsToFailure));
    if (b.failureRate === 0) {
      el.benchStatus.textContent = `${b.results.length} seeds tried in ${dt.toFixed(0)} ms`;
      el.benchNote.textContent = "This subject is correct (or the bug is rarer than 300 runs per seed catches): no failure found across any seed.";
    } else {
      el.benchStatus.textContent = `${b.results.length} seeds tried in ${dt.toFixed(0)} ms`;
      const pct = Math.round(b.failureRate * 100);
      el.benchNote.textContent =
        `The bug surfaced in ${pct}% of seeds within 300 runs each, averaging ${b.meanRunsToFailure.toFixed(1)} runs to first failure. ` +
        (b.failureRate < 1
          ? "The rest needed more than 300 runs, or got unlucky, or missed it entirely — a reminder that random testing is probabilistic, not exhaustive."
          : "Every seed found it: this bug is easy to trip over.");
    }
    el.benchBtn.disabled = false;
  });
}

function drawBenchChart(runsToFailure) {
  const cv = el.benchChart;
  const ctx = clearCanvas(cv);
  const col = chartColours();
  const found = runsToFailure.filter((x) => x !== null);
  if (found.length === 0) return;

  const pad = { l: 44, r: 20, t: 16, b: 34 };
  const W = cv.width, H = cv.height;
  const maxVal = Math.max(...found);
  const buckets = Math.min(24, maxVal + 1);
  const bucketWidth = (maxVal + 1) / buckets;
  const counts = new Array(buckets).fill(0);
  for (const v of found) counts[Math.min(buckets - 1, Math.floor(v / bucketWidth))]++;
  const maxCount = Math.max(1, ...counts);

  const barW = (W - pad.l - pad.r) / buckets;
  ctx.fillStyle = col.bad;
  counts.forEach((count, i) => {
    const h = (count / maxCount) * (H - pad.t - pad.b);
    ctx.fillRect(pad.l + i * barW + 1, H - pad.b - h, Math.max(1, barW - 2), h);
  });

  ctx.strokeStyle = col.border;
  ctx.beginPath();
  ctx.moveTo(pad.l, H - pad.b);
  ctx.lineTo(W - pad.r, H - pad.b);
  ctx.stroke();

  ctx.fillStyle = col.faint;
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillText("1", pad.l, H - pad.b + 16);
  ctx.textAlign = "right";
  ctx.fillText(String(maxVal), W - pad.r, H - pad.b + 16);
  ctx.textAlign = "center";
  ctx.fillText("runs to first failure \u2192", (pad.l + W - pad.r) / 2, H - 4);
}

// go
resetBenchmark();
runNow({ freshSeed: false });
