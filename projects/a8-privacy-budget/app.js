// app.js — all DOM wiring. The engine in dp.js has no DOM references.
import { generatePopulation, regionNames } from "./data.js";
import {
  PrivacyBudget,
  BudgetExhaustedError,
  runQuery,
  select,
  sumSensitivity,
  gaussianSigma,
  composeParallel,
  findUniqueTarget,
  differencingAttack,
  attackSuccessRate,
  errorVsEpsilon,
  sampleDistribution,
} from "./dp.js";

const $ = (id) => document.getElementById(id);

const people = generatePopulation();
const budget = new PrivacyBudget(3);
const target = findUniqueTarget(people);

// ---------- shared canvas helpers ----------

const css = getComputedStyle(document.documentElement);
const colour = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
const C = {
  grid: colour("--border", "#262d38"),
  axis: colour("--border-strong", "#39424f"),
  text: colour("--text-dim", "#9aa7b4"),
  faint: colour("--text-faint", "#6b7785"),
  accent: colour("--accent", "#4c8dff"),
  alt: colour("--alt", "#bc8cff"),
  good: colour("--good", "#3fb950"),
  warn: colour("--warn", "#d29922"),
  bad: colour("--bad", "#f85149"),
};

/** Sets up a canvas for its CSS size on this display, returns a plot frame. */
function frame(canvas, pad = { l: 54, r: 14, t: 16, b: 34 }) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(220, Math.round(rect.width || canvas.width));
  const h = Number(canvas.getAttribute("height"));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = "11px ui-monospace, monospace";
  ctx.lineWidth = 1;
  return {
    ctx,
    w,
    h,
    pad,
    plotW: w - pad.l - pad.r,
    plotH: h - pad.t - pad.b,
    x0: pad.l,
    y0: pad.t,
    y1: h - pad.b,
    x1: w - pad.r,
  };
}

function axes(f, { yTicks = 4, yLabel = (v) => v.toFixed(0), yMax = 1, yMin = 0 } = {}) {
  const { ctx } = f;
  ctx.strokeStyle = C.grid;
  ctx.fillStyle = C.text;
  ctx.textAlign = "right";
  for (let i = 0; i <= yTicks; i++) {
    const y = f.y0 + (f.plotH * i) / yTicks;
    ctx.beginPath();
    ctx.moveTo(f.x0, y);
    ctx.lineTo(f.x1, y);
    ctx.stroke();
    ctx.fillText(yLabel(yMax - ((yMax - yMin) * i) / yTicks), f.x0 - 8, y + 4);
  }
  ctx.textAlign = "left";
}

/**
 * Evenly-spaced tick values over [lo, hi] on an integer-valued axis, with the
 * step rounded up to at least 1 and duplicates dropped — otherwise a narrow
 * range (e.g. span 5 with 4 fractional ticks) rounds two neighbouring ticks
 * to the same integer label ("12, 13, 13, 14, 14").
 */
function integerTicks(lo, hi, count) {
  const step = Math.max(1, Math.round((hi - lo) / count));
  const ticks = [];
  for (let v = Math.round(lo); v <= hi + 1e-9; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] !== Math.round(hi)) ticks.push(Math.round(hi));
  return [...new Set(ticks)];
}

function fmtInt(n) {
  return Math.round(n).toLocaleString("en-GB");
}
function fmtKr(n) {
  return `${Math.round(n).toLocaleString("en-GB")} kr`;
}
function fmtShortKr(n) {
  return `${(n / 1000).toFixed(0)}k`;
}

// ---------- budget meter ----------

const budgetFill = $("budget-fill");
const meter = budgetFill.parentElement;
const budgetText = $("budget-text");
const budgetState = $("budget-state");
const ledgerBody = $("ledger-body");
const ledgerEmpty = $("ledger-empty");

function renderBudget(freshRow = false) {
  const frac = budget.fraction;
  budgetFill.style.width = `${(frac * 100).toFixed(2)}%`;
  budgetText.textContent = `ε ${budget.remaining.toFixed(3)} of ${budget.total.toFixed(3)} remaining`;
  meter.classList.toggle("low", frac <= 0.34 && frac > 0);
  meter.classList.toggle("empty", frac <= 0);

  budgetState.textContent = frac <= 0 ? "exhausted" : frac <= 0.34 ? "running low" : "healthy";
  budgetState.className = `tag ${frac <= 0 ? "bad" : frac <= 0.34 ? "warn" : "good"}`;

  $("stat-remaining").textContent = budget.remaining.toFixed(3);
  $("stat-spent").textContent = budget.spent.toFixed(3);
  $("stat-queries").textContent = String(budget.ledger.length);

  ledgerEmpty.hidden = budget.ledger.length > 0;
  ledgerBody.innerHTML = "";
  let left = budget.total;
  budget.ledger.forEach((entry, i) => {
    left -= entry.epsilon;
    const tr = document.createElement("tr");
    if (freshRow && i === budget.ledger.length - 1) tr.className = "fresh";
    tr.innerHTML = `
      <td class="num">${entry.at}</td>
      <td>${entry.label}</td>
      <td class="muted">${entry.composition || "sequential"}</td>
      <td class="num">${entry.epsilon.toFixed(3)}</td>
      <td class="num">${Math.max(0, left).toFixed(3)}</td>
    `;
    ledgerBody.appendChild(tr);
  });

  $("run-query-btn").disabled = budget.remaining <= 0;
}

$("reset-budget-btn").addEventListener("click", () => {
  budget.reset();
  renderBudget();
  $("query-status").textContent = "budget reset — in a real deployment this is a new data release, not a button";
});

// ---------- query builder ----------

const regionFilter = $("region-filter");
regionFilter.innerHTML =
  `<option value="">All of Denmark</option>` +
  regionNames().map((r) => `<option value="${r}">${r}</option>`).join("");
regionFilter.value = "Midtjylland";

const QUERIES = {
  "count-condition": {
    label: "count with diagnosis",
    build: (f) => ({ type: "count", filter: { ...f, condition: true } }),
    format: (v) => fmtInt(v) + " people",
  },
  "count-people": {
    label: "count of people",
    build: (f) => ({ type: "count", filter: f }),
    format: (v) => fmtInt(v) + " people",
  },
  "mean-income": {
    label: "mean income",
    needsClamp: true,
    build: (f, clamp) => ({ type: "mean", field: "income", clamp, filter: f }),
    format: (v) => (v == null ? "no rows" : fmtKr(v)),
  },
  "sum-income": {
    label: "total income",
    needsClamp: true,
    build: (f, clamp) => ({ type: "sum", field: "income", clamp, filter: f }),
    format: (v) => fmtKr(v),
  },
  "hist-region": {
    label: "diagnoses per region",
    build: () => ({
      type: "histogram",
      filter: { condition: true },
      buckets: regionNames().map((r) => ({ label: r, test: (p) => p.region === r })),
    }),
    format: () => "",
  },
};

function currentFilter() {
  const f = {};
  if (regionFilter.value) f.region = regionFilter.value;
  const lo = Number($("min-age").value);
  const hi = Number($("max-age").value);
  if (Number.isFinite(lo) && lo > 18) f.minAge = lo;
  if (Number.isFinite(hi) && hi < 89) f.maxAge = hi;
  return f;
}

function currentClamp() {
  return [Number($("clamp-lo").value) || 0, Number($("clamp-hi").value) || 800000];
}

function describeFilter(f) {
  const bits = [];
  bits.push(f.region ? `in ${f.region}` : "in all regions");
  if (f.minAge != null || f.maxAge != null) {
    bits.push(`aged ${f.minAge ?? 18}-${f.maxAge ?? 89}`);
  }
  return bits.join(", ");
}

function epsilonMood(eps) {
  if (eps < 0.1) return "very strong privacy";
  if (eps < 0.5) return "strong";
  if (eps < 1.5) return "typical published deployment";
  if (eps < 3) return "loose";
  return "weak — an attacker learns a lot";
}

function syncEpsilonLabel() {
  const eps = Number($("epsilon").value);
  $("epsilon-value").textContent = eps.toFixed(2);
  $("epsilon-mood").textContent = ` (${epsilonMood(eps)})`;
}

function syncClampVisibility() {
  $("clamp-controls").hidden = !QUERIES[$("query-type").value].needsClamp;
}

// ---------- running a query ----------

const workingBody = $("working-body");
const clampNote = $("clamp-note");
const histogramPanel = $("histogram-panel");

function working(rows) {
  workingBody.innerHTML = rows
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
    .join("");
}

function drawHistogram(bins) {
  const f = frame($("histogram-canvas"), { l: 46, r: 14, t: 14, b: 40 });
  const max = Math.max(1, ...bins.map((b) => Math.max(b.trueValue, b.noisyValue))) * 1.15;
  axes(f, { yMax: max });

  const slot = f.plotW / bins.length;
  bins.forEach((b, i) => {
    const x = f.x0 + slot * i + 8;
    const bw = (slot - 20) / 2;
    const bar = (value, fill, dx) => {
      const bh = (value / max) * f.plotH;
      f.ctx.fillStyle = fill;
      f.ctx.fillRect(x + dx, f.y1 - bh, bw, bh);
    };
    f.ctx.globalAlpha = 0.45;
    bar(b.trueValue, C.text, 0);
    f.ctx.globalAlpha = 1;
    bar(b.noisyValue, C.accent, bw + 4);

    f.ctx.fillStyle = C.text;
    f.ctx.textAlign = "center";
    f.ctx.fillText(b.label.slice(0, 12), x + bw, f.y1 + 16);
    f.ctx.fillStyle = C.faint;
    f.ctx.fillText(`${b.trueValue} → ${b.noisyValue}`, x + bw, f.y1 + 30);
  });
  f.ctx.textAlign = "left";
}

function showRefusal(err) {
  $("answer-badge").textContent = "refused";
  $("answer-badge").className = "tag bad";
  document.querySelector(".noisy-answer").classList.add("refused");
  const dry = err.remaining <= 1e-9;
  $("noisy-answer").textContent = dry ? "Budget exhausted" : "Too expensive";
  $("true-answer").textContent = "—";
  $("answer-delta").textContent = err.message;
  histogramPanel.hidden = true;
  working([
    ["requested", `ε ${err.requested.toFixed(3)}`],
    ["remaining", `ε ${err.remaining.toFixed(3)}`],
    [
      dry ? "what a real system does now" : "your options",
      dry
        ? "stop answering, or start a fresh data release"
        : `lower ε to ${err.remaining.toFixed(2)} or below, and accept a blurrier answer`,
    ],
  ]);
}

function runCurrentQuery() {
  const key = $("query-type").value;
  const q = QUERIES[key];
  const epsilon = Number($("epsilon").value);
  const mechanism = $("mechanism").value;
  const filter = currentFilter();
  const clamp = currentClamp();
  const spec = q.build(filter, clamp);
  const isHistogram = spec.type === "histogram";

  const label =
    `${q.label} ${isHistogram ? "(all regions)" : describeFilter(filter)}` +
    (mechanism === "gaussian" ? " · Gaussian" : "");

  let entry;
  try {
    entry = budget.spend(epsilon, label, {
      composition: isHistogram ? "parallel over 5 bins" : "sequential",
    });
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      renderBudget();
      showRefusal(err);
      $("query-status").textContent =
        err.remaining <= 1e-9
          ? "refused — the budget is gone, reset to carry on exploring"
          : "refused — that ε costs more than is left";
      return;
    }
    throw err;
  }

  const res = runQuery(people, spec, { epsilon, mechanism, rng: Math.random });

  document.querySelector(".noisy-answer").classList.remove("refused");
  $("answer-badge").textContent = `ε ${epsilon.toFixed(2)} · ${mechanism}`;
  $("answer-badge").className = "tag good";

  if (isHistogram) {
    histogramPanel.hidden = false;
    drawHistogram(res.bins);
    const trueTotal = res.trueValue.reduce((a, b) => a + b, 0);
    const noisyTotal = res.noisyValue.reduce((a, b) => a + b, 0);
    $("true-answer").textContent = `${fmtInt(trueTotal)} total`;
    $("noisy-answer").textContent = `${fmtInt(noisyTotal)} total`;
    $("answer-delta").textContent = `across ${res.bins.length} regions`;
    working([
      ["sensitivity of each bin", "1 person"],
      ["Laplace scale b", `1 / ${epsilon.toFixed(2)} = ${res.scale.toFixed(2)}`],
      ["composition", `parallel — max(ε…) = ${composeParallel(res.bins.map(() => epsilon)).toFixed(2)}`],
      ["charged to the budget", `ε ${entry.epsilon.toFixed(3)}`],
    ]);
  } else {
    histogramPanel.hidden = true;
    $("true-answer").textContent = q.format(res.trueValue);
    $("noisy-answer").textContent = q.format(res.noisyValue);
    const err = res.trueValue == null ? null : res.noisyValue - res.trueValue;
    $("answer-delta").textContent =
      err == null
        ? "no rows matched the filter"
        : `off by ${res.type === "count" ? fmtInt(Math.abs(err)) : fmtKr(Math.abs(err))} this time`;

    const rows = [
      ["rows matching the filter", `${fmtInt(res.n)} people`],
      ["sensitivity Δ", res.type === "count" ? "1 person" : fmtKr(res.sensitivity)],
    ];
    if (mechanism === "gaussian") {
      rows.push(["Gaussian σ = Δ·√(2 ln(1.25/δ))/ε", gaussianSigma(res.sensitivity, res.type === "mean" ? epsilon / 2 : epsilon).toFixed(2)]);
    } else {
      rows.push(["Laplace scale b = Δ/ε", res.scale.toFixed(2)]);
    }
    if (res.type === "mean") {
      rows.push(["split", `ε/2 = ${res.splitEpsilon.toFixed(3)} on the sum, ${res.splitEpsilon.toFixed(3)} on the count`]);
    }
    rows.push(["charged to the budget", `ε ${entry.epsilon.toFixed(3)}`]);
    working(rows);

    if (res.clamped != null && res.clamped > 0) {
      clampNote.hidden = false;
      clampNote.innerHTML =
        `<strong>${res.clamped}</strong> of ${fmtInt(res.n)} incomes were clamped to ` +
        `[${fmtShortKr(clamp[0])}, ${fmtShortKr(clamp[1])}]. That clamp is not tidying: ` +
        `without it a single person could move the sum without limit, the sensitivity would be ` +
        `infinite, and no amount of noise would be enough. Sensitivity is ` +
        `${fmtKr(sumSensitivity(clamp[0], clamp[1]))} precisely because of it.`;
    } else {
      clampNote.hidden = true;
    }
  }

  renderBudget(true);
  $("query-status").textContent =
    budget.remaining <= 0 ? "that was the last one — the database is closed now" : "answered";
}

$("run-query-btn").addEventListener("click", runCurrentQuery);
$("epsilon").addEventListener("input", syncEpsilonLabel);
$("query-type").addEventListener("change", syncClampVisibility);

// ---------- epsilon explorer ----------

const EXPLORER_SPEC = {
  type: "count",
  filter: { region: "Midtjylland", condition: true },
};
const EXPLORER_RUNS = 2000;
const explorerTrue = runQuery(people, EXPLORER_SPEC, { privacy: false }).trueValue;

function drawExplorer(epsilon) {
  const samples = Array.from(sampleDistribution(people, EXPLORER_SPEC, epsilon, EXPLORER_RUNS, 3));
  samples.sort((a, b) => a - b);
  const q = (p) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  const lo = q(0.02);
  const hi = q(0.98);
  const span = Math.max(6, hi - lo);
  const viewLo = Math.floor(Math.min(lo, explorerTrue - span * 0.12));
  const viewHi = Math.ceil(Math.max(hi, explorerTrue + span * 0.12));

  // Counts are integers, so at small epsilon the support is only a handful of
  // values. Binning finer than 1 there produces a comb of empty gaps rather
  // than the Laplace shape, so the bin count is capped to the integer span.
  const viewSpan = viewHi - viewLo;
  const bins = Math.max(5, Math.min(61, viewSpan));
  const counts = new Array(bins).fill(0);
  const width = viewSpan / bins || 1;
  for (const s of samples) {
    const i = Math.floor((s - viewLo) / width);
    if (i >= 0 && i < bins) counts[i]++;
  }
  const max = Math.max(1, ...counts);

  const f = frame($("explorer-canvas"), { l: 54, r: 16, t: 18, b: 40 });
  axes(f, { yMax: max, yTicks: 4, yLabel: (v) => v.toFixed(0) });

  const xOf = (value) => f.x0 + ((value - viewLo) / (viewHi - viewLo)) * f.plotW;

  // the 80% central band, so "how wrong could this be" is legible at a glance
  const b10 = q(0.1);
  const b90 = q(0.9);
  f.ctx.fillStyle = "rgba(76, 141, 255, .1)";
  f.ctx.fillRect(xOf(b10), f.y0, Math.max(1, xOf(b90) - xOf(b10)), f.plotH);

  const bw = f.plotW / bins;
  f.ctx.fillStyle = C.accent;
  counts.forEach((c, i) => {
    const h = (c / max) * f.plotH;
    f.ctx.fillRect(f.x0 + bw * i + 0.5, f.y1 - h, Math.max(1, bw - 1), h);
  });

  // the truth
  f.ctx.strokeStyle = C.warn;
  f.ctx.lineWidth = 2;
  f.ctx.beginPath();
  f.ctx.moveTo(xOf(explorerTrue), f.y0 - 4);
  f.ctx.lineTo(xOf(explorerTrue), f.y1);
  f.ctx.stroke();
  f.ctx.lineWidth = 1;
  f.ctx.fillStyle = C.warn;
  f.ctx.textAlign = "center";
  f.ctx.fillText(`truth ${explorerTrue}`, xOf(explorerTrue), f.y0 - 6);

  f.ctx.fillStyle = C.text;
  // x-axis values are integers (they're counts), so four evenly-spaced
  // fractions of a narrow view can round to the same integer twice
  // ("12, 13, 13, 14, 14"). Snap the tick step to whole numbers and dedupe.
  for (const v of integerTicks(viewLo, viewHi, 4)) {
    f.ctx.fillText(fmtInt(v), xOf(v), f.y1 + 18);
  }
  f.ctx.fillStyle = C.faint;
  f.ctx.fillText("answer the analyst receives", f.x0 + f.plotW / 2, f.y1 + 33);
  f.ctx.textAlign = "left";

  $("explorer-true").textContent = fmtInt(explorerTrue);
  $("explorer-spread").textContent = `${fmtInt(b10)} – ${fmtInt(b90)}`;
}

$("explorer-epsilon").addEventListener("input", () => {
  const eps = Number($("explorer-epsilon").value);
  $("explorer-epsilon-value").textContent = eps.toFixed(2);
  drawExplorer(eps);
});

// ---------- the attack ----------

const attackPanel = $("attack-panel");
const attackResult = $("attack-result");
const privacyToggle = $("privacy-toggle");
const attackTableBody = $("attack-table-body");
let attackCurve = null;

/** Column-aligns the two-query arithmetic so it reads like a worked sum. */
function arith(rows) {
  const width = Math.max(...rows.map(([, mid]) => mid.length));
  return rows
    .map(([tag, mid, value]) => `${tag.padEnd(8)} ${mid.padEnd(width)} = ${value}`)
    .join("\n");
}

function syncPrivacyLabel() {
  const on = privacyToggle.checked;
  $("privacy-label").textContent = `Differential privacy: ${on ? "ON" : "OFF"}`;
  privacyToggle.parentElement.classList.toggle("off", !on);
  if (on) attackPanel.classList.remove("exposed");
}

privacyToggle.addEventListener("change", () => {
  syncPrivacyLabel();
  $("attack-status").textContent = privacyToggle.checked
    ? "noise back on — run it again"
    : "noise disabled — run the attack";
});

$("run-attack-btn").addEventListener("click", () => {
  const privacy = privacyToggle.checked;
  const epsilon = Number($("epsilon").value);
  const r = differencingAttack(people, target, { epsilon, privacy, rng: Math.random });

  const who =
    `person #${target.id}, aged ${target.age} in postcode ${target.postcode} (${target.region})`;

  if (!privacy) {
    attackPanel.classList.add("exposed");
    attackResult.className = "attack-result breach";
    attackResult.innerHTML = `
      <p class="verdict">We just learned that <span class="subject">${who}</span>
        ${r.truth ? "has the chronic diagnosis" : "does not have the chronic diagnosis"} —
        from two aggregate queries that named nobody.</p>
      <div class="arith">${arith([
        ["query A", `diagnoses in ${target.region}`, r.broadCount.trueValue],
        ["query B", `the same, excluding age ${target.age} in ${target.postcode}`, r.narrowCount.trueValue],
        ["", "A − B", r.difference],
      ])}
a difference of ${r.difference} is one person's private bit, exactly.</div>
      <p class="faint" style="margin-bottom:0;">Neither query would fail a review.
        The disclosure lives in the pair, which is exactly what a budget over the
        whole query sequence is for.</p>
    `;
    $("attack-status").textContent = "attack succeeded";
    return;
  }

  attackResult.className = "attack-result defended";
  attackResult.innerHTML = `
    <p class="verdict">The attacker guessed
      ${r.guess ? "\u201chas the diagnosis\u201d" : "\u201cdoes not have the diagnosis\u201d"}
      and was ${r.correct ? "right this time" : "wrong"} — but has no way to know which.</p>
    <div class="arith">${arith([
      ["query A", `noisy count in ${target.region}`, r.broadCount.rawNoisy.toFixed(2)],
      ["query B", "noisy count excluding the target", r.narrowCount.rawNoisy.toFixed(2)],
      ["", "A − B", r.difference.toFixed(2)],
    ])}
the quantity being hidden is 0 or 1; the noise is ±${(1 / epsilon).toFixed(1)} on each query.</div>
    <p class="faint" style="margin-bottom:0;">Cost of the attempt: ε ${r.epsilonSpent.toFixed(2)}
      against the budget, since two counts over the same people compose sequentially.
      Repeating it to average out the noise is exactly what the budget forbids.</p>
  `;
  $("attack-status").textContent = "attack defeated (single attempt — see the curve)";
});

const ATTACK_EPSILONS = [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16];
const ATTACK_TRIALS = 500;

function drawAttackCurve() {
  const f = frame($("attack-canvas"), { l: 48, r: 16, t: 18, b: 42 });
  axes(f, { yMax: 1, yMin: 0, yTicks: 4, yLabel: (v) => `${(v * 100).toFixed(0)}%` });
  if (!attackCurve) {
    f.ctx.fillStyle = C.faint;
    f.ctx.fillText("press the button to measure", f.x0 + 12, f.y0 + f.plotH / 2);
    return;
  }

  const logs = attackCurve.map((p) => Math.log10(p.epsilon));
  const lo = Math.min(...logs);
  const hi = Math.max(...logs);
  const xOf = (eps) => f.x0 + ((Math.log10(eps) - lo) / (hi - lo)) * f.plotW;
  const yOf = (rate) => f.y1 - rate * f.plotH;

  // chance line
  f.ctx.strokeStyle = C.good;
  f.ctx.setLineDash([5, 4]);
  f.ctx.beginPath();
  f.ctx.moveTo(f.x0, yOf(0.5));
  f.ctx.lineTo(f.x1, yOf(0.5));
  f.ctx.stroke();
  f.ctx.setLineDash([]);
  f.ctx.fillStyle = C.good;
  f.ctx.fillText("coin flip — nothing learned", f.x0 + 6, yOf(0.5) - 6);

  f.ctx.strokeStyle = C.bad;
  f.ctx.lineWidth = 2;
  f.ctx.beginPath();
  attackCurve.forEach((p, i) => {
    const x = xOf(p.epsilon);
    const y = yOf(p.rate);
    if (i === 0) f.ctx.moveTo(x, y);
    else f.ctx.lineTo(x, y);
  });
  f.ctx.stroke();
  f.ctx.lineWidth = 1;

  f.ctx.fillStyle = C.bad;
  for (const p of attackCurve) {
    f.ctx.beginPath();
    f.ctx.arc(xOf(p.epsilon), yOf(p.rate), 3, 0, Math.PI * 2);
    f.ctx.fill();
  }

  f.ctx.fillStyle = C.text;
  f.ctx.textAlign = "center";
  for (const eps of [0.02, 0.1, 0.5, 2, 16]) {
    f.ctx.fillText(String(eps), xOf(eps), f.y1 + 18);
  }
  f.ctx.fillStyle = C.faint;
  f.ctx.fillText("ε per query (log scale)", f.x0 + f.plotW / 2, f.y1 + 34);
  f.ctx.textAlign = "left";
}

$("attack-curve-btn").addEventListener("click", () => {
  $("attack-status").textContent = `measuring ${ATTACK_EPSILONS.length} × ${ATTACK_TRIALS} attacks…`;
  $("attack-curve-btn").disabled = true;
  // let the status paint before the synchronous measurement
  requestAnimationFrame(() => {
    attackCurve = ATTACK_EPSILONS.map((epsilon) => ({
      epsilon,
      rate: attackSuccessRate(people, target, epsilon, ATTACK_TRIALS, 23),
    }));
    drawAttackCurve();
    attackTableBody.innerHTML = attackCurve
      .map((p) => {
        const breach = p.rate >= 0.75;
        const verdict = breach
          ? "the bit is effectively public"
          : p.rate >= 0.6
            ? "leaking"
            : "indistinguishable from guessing";
        return `<tr class="${breach ? "breach" : p.rate < 0.6 ? "safe" : ""}">
          <td class="num">${p.epsilon}</td>
          <td class="num">${(p.rate * 100).toFixed(1)}%</td>
          <td class="muted">${verdict}</td>
        </tr>`;
      })
      .join("");
    $("attack-status").textContent =
      `${ATTACK_EPSILONS.length * ATTACK_TRIALS} attacks run in this browser just now`;
    $("attack-curve-btn").disabled = false;
  });
});

// ---------- error benchmark ----------

const BENCH_EPSILONS = [0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2];
const BENCH_TRIALS = 300;
const BENCH_SPEC = { type: "count", filter: { region: "Hovedstaden", condition: true } };
let benchRows = null;

function drawBench() {
  const f = frame($("bench-canvas"), { l: 54, r: 16, t: 18, b: 42 });
  if (!benchRows) {
    axes(f, { yMax: 1 });
    f.ctx.fillStyle = C.faint;
    f.ctx.fillText("press the button to measure", f.x0 + 12, f.y0 + f.plotH / 2);
    return;
  }

  const max = Math.max(...benchRows.map((r) => Math.max(r.measured, r.theoretical))) * 1.1;
  axes(f, { yMax: max, yLabel: (v) => v.toFixed(1) });

  const logs = benchRows.map((r) => Math.log10(r.epsilon));
  const lo = Math.min(...logs);
  const hi = Math.max(...logs);
  const xOf = (eps) => f.x0 + ((Math.log10(eps) - lo) / (hi - lo)) * f.plotW;
  const yOf = (v) => f.y1 - (v / max) * f.plotH;

  const line = (key, stroke, dash) => {
    f.ctx.strokeStyle = stroke;
    f.ctx.setLineDash(dash);
    f.ctx.lineWidth = 2;
    f.ctx.beginPath();
    benchRows.forEach((r, i) => {
      const x = xOf(r.epsilon);
      const y = yOf(r[key]);
      if (i === 0) f.ctx.moveTo(x, y);
      else f.ctx.lineTo(x, y);
    });
    f.ctx.stroke();
    f.ctx.setLineDash([]);
    f.ctx.lineWidth = 1;
  };

  line("theoretical", C.alt, [6, 4]);
  line("measured", C.accent, []);

  f.ctx.fillStyle = C.accent;
  for (const r of benchRows) {
    f.ctx.beginPath();
    f.ctx.arc(xOf(r.epsilon), yOf(r.measured), 3, 0, Math.PI * 2);
    f.ctx.fill();
  }

  f.ctx.fillStyle = C.accent;
  f.ctx.fillText("measured", f.x1 - 130, f.y0 + 12);
  f.ctx.fillStyle = C.alt;
  f.ctx.fillText("theory Δ/ε", f.x1 - 60, f.y0 + 12);

  f.ctx.fillStyle = C.text;
  f.ctx.textAlign = "center";
  for (const r of benchRows) f.ctx.fillText(String(r.epsilon), xOf(r.epsilon), f.y1 + 18);
  f.ctx.fillStyle = C.faint;
  f.ctx.fillText("ε (log scale) — mean absolute error in people", f.x0 + f.plotW / 2, f.y1 + 34);
  f.ctx.textAlign = "left";
}

$("run-bench-btn").addEventListener("click", () => {
  $("bench-status").textContent = "measuring…";
  $("run-bench-btn").disabled = true;
  requestAnimationFrame(() => {
    const t0 = performance.now();
    benchRows = errorVsEpsilon(people, BENCH_SPEC, BENCH_EPSILONS, BENCH_TRIALS, 11);
    const ms = performance.now() - t0;
    drawBench();
    $("bench-table-body").innerHTML = benchRows
      .map(
        (r) => `<tr>
          <td class="num">${r.epsilon}</td>
          <td class="num">${r.measured.toFixed(1)}</td>
          <td class="num muted">${r.theoretical.toFixed(1)}</td>
          <td class="num">${((r.measured / r.trueValue) * 100).toFixed(1)}%</td>
        </tr>`
      )
      .join("");
    $("bench-status").textContent =
      `${BENCH_EPSILONS.length * BENCH_TRIALS} simulated releases of a count of ` +
      `${benchRows[0].trueValue} people, measured in ${ms.toFixed(0)} ms. Simulation only: no budget spent.`;
    $("run-bench-btn").disabled = false;
  });
});

// ---------- analysis under DP ----------

const analysisTableBody = $("analysis-table-body");
const ANALYSIS_CLAMP = [0, 800000];

function analysisRows(epsilon) {
  return regionNames().map((region) => {
    const filter = { region };
    const spec = { type: "mean", field: "income", clamp: ANALYSIS_CLAMP, filter };
    const exact = runQuery(people, spec, { privacy: false });
    const noisy = runQuery(people, spec, { epsilon, rng: Math.random });
    return {
      region,
      n: select(people, filter).length,
      trueValue: exact.trueValue,
      noisyValue: noisy.noisyValue,
    };
  });
}

function drawAnalysis(rows) {
  const f = frame($("analysis-canvas"), { l: 62, r: 16, t: 18, b: 42 });
  const max = Math.max(...rows.map((r) => Math.max(r.trueValue, r.noisyValue))) * 1.2;
  axes(f, { yMax: max, yLabel: (v) => fmtShortKr(v) });

  const slot = f.plotW / rows.length;
  rows.forEach((r, i) => {
    const x = f.x0 + slot * i + 10;
    const bw = (slot - 26) / 2;
    f.ctx.globalAlpha = 0.4;
    f.ctx.fillStyle = C.text;
    f.ctx.fillRect(x, f.y1 - (r.trueValue / max) * f.plotH, bw, (r.trueValue / max) * f.plotH);
    f.ctx.globalAlpha = 1;
    f.ctx.fillStyle = C.accent;
    f.ctx.fillRect(x + bw + 6, f.y1 - (r.noisyValue / max) * f.plotH, bw, (r.noisyValue / max) * f.plotH);

    f.ctx.fillStyle = C.text;
    f.ctx.textAlign = "center";
    f.ctx.fillText(r.region, x + bw + 3, f.y1 + 17);
    f.ctx.fillStyle = C.faint;
    f.ctx.fillText(`${fmtShortKr(r.trueValue)} → ${fmtShortKr(r.noisyValue)}`, x + bw + 3, f.y1 + 31);
  });

  f.ctx.fillStyle = C.text;
  f.ctx.textAlign = "left";
  f.ctx.globalAlpha = 0.5;
  f.ctx.fillText("true", f.x1 - 96, f.y0 + 12);
  f.ctx.globalAlpha = 1;
  f.ctx.fillStyle = C.accent;
  f.ctx.fillText("released under DP", f.x1 - 66, f.y0 + 12);
}

function renderAnalysis() {
  const epsilon = Number($("analysis-epsilon").value);
  $("analysis-epsilon-value").textContent = epsilon.toFixed(2);
  const rows = analysisRows(epsilon);
  drawAnalysis(rows);
  analysisTableBody.innerHTML = rows
    .map((r) => {
      const diff = r.noisyValue - r.trueValue;
      return `<tr>
        <td>${r.region}</td>
        <td class="num">${fmtInt(r.n)}</td>
        <td class="num muted">${fmtKr(r.trueValue)}</td>
        <td class="num">${fmtKr(r.noisyValue)}</td>
        <td class="num">${diff >= 0 ? "+" : "−"}${fmtKr(Math.abs(diff))}</td>
      </tr>`;
    })
    .join("");
}

$("analysis-epsilon").addEventListener("input", renderAnalysis);

// ---------- init ----------

function init() {
  syncEpsilonLabel();
  syncClampVisibility();
  syncPrivacyLabel();
  renderBudget();

  // Open on something interesting: one query already answered, budget already moving.
  runCurrentQuery();
  $("query-status").textContent = "one query has already been run for you";

  drawExplorer(Number($("explorer-epsilon").value));
  drawAttackCurve();
  drawBench();
  renderAnalysis();
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    drawExplorer(Number($("explorer-epsilon").value));
    drawAttackCurve();
    drawBench();
    renderAnalysis();
    if (!histogramPanel.hidden) $("run-query-btn").blur();
  }, 150);
});

init();
