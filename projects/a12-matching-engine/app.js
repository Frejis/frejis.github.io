// DOM and canvas only. All engine logic lives in orderbook.js, all timing
// and statistics in latency.js. This file just wires them to the page.

import { OrderBook, makeRng, nextAction, applyAction } from "./orderbook.js";
import { LatencyRecorder, computeStats, logHistogram, calibrateClockResolution, calibrateBatchSize, safeRatio } from "./latency.js";

const $ = (id) => document.getElementById(id);

const el = {
  ladder: $("ladder"),
  spreadTag: $("spread-tag"),

  sideSelect: $("side-select"),
  priceInput: $("price-input"),
  qtyInput: $("qty-input"),
  limitBtn: $("limit-btn"),
  marketBtn: $("market-btn"),
  cancelInput: $("cancel-input"),
  cancelBtn: $("cancel-btn"),
  orderStatus: $("order-status"),

  tape: $("tape"),
  tapeCount: $("tape-count"),

  runBtn: $("run-btn"),
  seedInput: $("seed-input"),
  resetBtn: $("reset-btn"),
  runStatus: $("run-status"),
  runTag: $("run-tag"),

  latencyChart: $("latency-chart"),
  statThroughput: $("stat-throughput"),
  statP50: $("stat-p50"),
  statP90: $("stat-p90"),
  statP99: $("stat-p99"),
  statP999: $("stat-p999"),
  statMax: $("stat-max"),
  latencyNote: $("latency-note"),
};

const MID = 10000;
const state = {
  book: new OrderBook(),
  trades: [], // most recent first, capped
  latencySamples: null, // microseconds, from the last "run N orders"
};

const groups = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");

// ------------------------------------------------------------------- startup

// Preload the book so the ladder is never empty on load: a spread of
// resting orders on both sides, a few ticks deep, seeded so it looks the
// same every time.
function preload() {
  const rng = makeRng(20260904);
  for (let i = 0; i < 60; i++) {
    const action = nextAction(rng, state.book);
    // Discard preload trades from the tape - this is scene-setting, not
    // something the visitor asked for.
    applyAction(state.book, action);
  }
  state.trades = [];
}

preload();
renderLadder();
renderTape();

// ------------------------------------------------------------------- ladder

function renderLadder() {
  const depth = state.book.depth(8);
  const bestBid = state.book.bestBid();
  const bestAsk = state.book.bestAsk();
  const spread = state.book.spread();

  el.spreadTag.textContent = spread !== null ? `spread ${spread}` : "spread —";

  const maxQty = Math.max(1, ...depth.bids.map((l) => l.qty), ...depth.asks.map((l) => l.qty));
  const rowHtml = (level, side) => {
    const pct = Math.round((level.qty / maxQty) * 100);
    return (
      `<div class="ladder-row ${side}">` +
      `<div class="bar" style="width:${pct}%"></div>` +
      `<span class="price mono">${side === "bid" ? level.price : ""}</span>` +
      `<span class="price mono" style="grid-column:2">${side === "ask" ? level.price : ""}</span>` +
      `<span class="qty mono">${side === "ask" ? level.qty : ""}</span>` +
      `<span class="qty mono" style="grid-column:1">${side === "bid" ? level.qty : ""}</span>` +
      `</div>`
    );
  };

  if (depth.asks.length === 0 && depth.bids.length === 0) {
    el.ladder.innerHTML = `<p class="ladder-empty">Book is empty.</p>`;
    return;
  }

  const asksHtml = depth.asks.slice().reverse().map((l) => rowHtml(l, "ask")).join("");
  const bidsHtml = depth.bids.map((l) => rowHtml(l, "bid")).join("");
  const spreadHtml = `<div class="ladder-spread">${
    bestBid !== null && bestAsk !== null
      ? `bid ${bestBid} &nbsp;·&nbsp; ask ${bestAsk} &nbsp;·&nbsp; spread ${spread}`
      : "one side of the book is empty"
  }</div>`;

  el.ladder.innerHTML = asksHtml + spreadHtml + bidsHtml;
}

// ------------------------------------------------------------------- tape

function renderTape() {
  el.tapeCount.textContent = `${groups(state.trades.length)} trades shown`;
  if (state.trades.length === 0) {
    el.tape.innerHTML = `<p class="tape-empty">No trades yet. Submit an order priced to cross the spread.</p>`;
    return;
  }
  el.tape.innerHTML = state.trades
    .slice(0, 200)
    .map(
      (t) =>
        `<div class="tape-row ${t.aggressorSide === "buy" ? "buy" : "sell"}">` +
        `<span>${t.aggressorSide === "buy" ? "BUY " : "SELL"}</span>` +
        `<span>${groups(t.qty)} @ ${t.price}</span>` +
        `<span class="faint">#${t.makerOrderId}\u2194#${t.takerOrderId}</span>` +
        `</div>`
    )
    .join("");
}

function recordTrades(trades) {
  if (trades.length === 0) return;
  state.trades = trades.concat(state.trades).slice(0, 500);
}

// ------------------------------------------------------------------- controls

el.limitBtn.addEventListener("click", () => {
  const side = el.sideSelect.value;
  const price = Number(el.priceInput.value);
  const qty = Math.max(1, Math.floor(Number(el.qtyInput.value) || 1));
  try {
    const { orderId, trades } = state.book.addLimitOrder(side, price, qty);
    recordTrades(trades);
    el.orderStatus.textContent = trades.length
      ? `order #${orderId}: ${trades.length} fill(s), ${groups(trades.reduce((s, t) => s + t.qty, 0))} filled immediately.`
      : `order #${orderId} rests on the book (no cross).`;
  } catch (err) {
    el.orderStatus.textContent = `rejected: ${err.message}`;
  }
  renderLadder();
  renderTape();
});

el.marketBtn.addEventListener("click", () => {
  const side = el.sideSelect.value;
  const qty = Math.max(1, Math.floor(Number(el.qtyInput.value) || 1));
  try {
    const { orderId, trades } = state.book.addMarketOrder(side, qty);
    recordTrades(trades);
    const filled = trades.reduce((s, t) => s + t.qty, 0);
    el.orderStatus.textContent = trades.length
      ? `market order #${orderId}: ${groups(filled)} filled across ${trades.length} level-crossing(s)${filled < qty ? ", book exhausted before the rest filled" : ""}.`
      : `market order #${orderId}: nothing to match, opposite side of the book is empty.`;
  } catch (err) {
    el.orderStatus.textContent = `rejected: ${err.message}`;
  }
  renderLadder();
  renderTape();
});

el.cancelBtn.addEventListener("click", () => {
  const id = Number(el.cancelInput.value);
  const ok = state.book.cancelOrder(id);
  el.orderStatus.textContent = ok ? `order #${id} cancelled.` : `order #${id} is not a live resting order.`;
  renderLadder();
});

el.resetBtn.addEventListener("click", () => {
  state.book = new OrderBook();
  preload();
  el.orderStatus.textContent = "book reset and reloaded.";
  renderLadder();
  renderTape();
});

// ------------------------------------------------------------------- run flow

// This browser's performance.now() is coarsened (a Spectre-era side-channel
// mitigation) to a tick that a single order-book operation cannot clear -
// almost every individual timing quantises to 0, and the rest land on
// whatever the tick size happens to be. Timing single operations is
// therefore impossible; instead we time BATCHES of K operations with one
// performance.now() pair and divide by K for a per-operation figure. K is
// picked at runtime (calibrateBatchSize) against the clock this browser
// actually has, on a throwaway warm-up book, so it is never hand-tuned to a
// tick size that happens to be true today. The result is smoother than a
// genuine per-operation distribution - it cannot show a true single-op
// outlier that batches average away - and every label on the page says so.
const BATCH_CALIBRATION_TARGET_MS = 1;

function calibrateBatch(seed) {
  const warmupRng = makeRng(seed);
  const warmupBook = new OrderBook();
  const clockResolutionMs = calibrateClockResolution();
  const batchSize = calibrateBatchSize(() => applyAction(warmupBook, nextAction(warmupRng, warmupBook)), {
    tickMs: clockResolutionMs,
    targetMs: BATCH_CALIBRATION_TARGET_MS,
  });
  return { clockResolutionMs, batchSize };
}

// Streams `n` generated orders through a FRESH book (so the run is not
// polluted by whatever the visitor has clicked by hand) and times batches of
// `batchSize` operations at a time. Runs in chunks via requestAnimationFrame
// so the "n = 50,000" run does not lock up the tab, and so the "running..."
// status actually paints.
function runOrderFlow(n, seed, batchSize) {
  const rng = makeRng(seed);
  const book = new OrderBook();
  const batchCount = Math.ceil(n / batchSize);
  const rec = new LatencyRecorder(batchCount); // one sample per BATCH, not per order
  const chunkBatches = Math.max(1, Math.round(2000 / batchSize));
  let done = 0; // orders applied
  let batchesDone = 0;
  const trades = []; // arrival order; reversed to "most recent first" once, at the end
  const t0 = performance.now();

  return new Promise((resolve) => {
    function step() {
      const endBatches = Math.min(batchCount, batchesDone + chunkBatches);
      while (batchesDone < endBatches) {
        const batchStart = performance.now();
        const batchN = Math.min(batchSize, n - done);
        for (let i = 0; i < batchN; i++) {
          const { trades: t } = applyAction(book, nextAction(rng, book));
          if (t.length) trades.push(...t);
        }
        rec.record((performance.now() - batchStart) / batchN);
        done += batchN;
        batchesDone++;
      }
      el.runStatus.textContent = batchesDone < batchCount
        ? `${groups(done)} / ${groups(n)} orders...`
        : `${groups(done)} / ${groups(n)} orders done.`;
      if (batchesDone < batchCount) {
        requestAnimationFrame(step);
      } else {
        const wallMs = performance.now() - t0;
        // Last 500, most-recent-first - same shape recordTrades keeps for the tape.
        const recentTrades = trades.slice(-500).reverse();
        resolve({ book, samplesMs: rec.toArray(), wallMs, trades: recentTrades });
      }
    }
    requestAnimationFrame(step);
  });
}

el.runBtn.addEventListener("click", async () => {
  const n = 50000;
  const seed = Math.floor(Number(el.seedInput.value)) || 1;
  el.runBtn.disabled = true;
  el.runTag.textContent = "running...";
  el.runTag.className = "tag";

  const { clockResolutionMs, batchSize } = calibrateBatch(seed);
  const { book, samplesMs, wallMs, trades } = await runOrderFlow(n, seed, batchSize);

  // The engine's own book replaces the one the visitor was poking at, so
  // the ladder now reflects exactly what 50,000 orders of flow produced -
  // and the tape shows the most recent of the trades that flow generated,
  // same as after a hand-submitted order.
  state.book = book;
  state.trades = trades;
  renderLadder();
  renderTape();

  // Convert to microseconds: individual matching-engine operations here
  // are sub-microsecond to low-microsecond, and "0.03 ms" reads worse than
  // "30 µs". Each sample is already a per-operation figure (a batch's
  // elapsed time divided by its batch size), so these percentiles are
  // percentiles ACROSS BATCHES, not across individual operations - smoother
  // than the real distribution, and unable to show a true single-op spike.
  const samplesUs = samplesMs.map((ms) => ms * 1000);
  state.latencySamples = samplesUs;
  const stats = computeStats(samplesUs);
  const throughput = n / (wallMs / 1000);
  const tailRatio = safeRatio(stats.p999, stats.p50);

  el.statThroughput.textContent = groups(throughput);
  el.statP50.textContent = stats.p50.toFixed(2);
  el.statP90.textContent = stats.p90.toFixed(2);
  el.statP99.textContent = stats.p99.toFixed(2);
  el.statP999.textContent = stats.p999.toFixed(2);
  el.statMax.textContent = stats.max.toFixed(2);

  const tailPhrase = tailRatio !== null
    ? `${tailRatio.toFixed(1)}\u00d7 the typical batch`
    : "not computable (typical batch cost rounded to zero)";
  // µs, not ms: a browser's measured tick is typically ~100µs, and
  // "0.000 ms" from a naive fixed-decimal ms format would repeat the exact
  // "reads as zero" failure this whole page exists to avoid.
  const clockResolutionUs = clockResolutionMs * 1000;
  el.latencyNote.textContent =
    `${groups(n)} orders in ${groups(wallMs)} ms, timed in batches of ${groups(batchSize)} operations ` +
    `(this browser's clock ticks at roughly ${clockResolutionUs.toFixed(2)} \u00b5s, too coarse to time one ` +
    `operation directly). Figures below are per-operation cost, averaged over each batch, with ` +
    `percentiles computed across batches \u2014 not across individual operations. Half of all batches ` +
    `averaged under ${stats.p50.toFixed(2)} \u00b5s per operation; the slowest 1 in 1000 batches ` +
    `averaged ${stats.p999.toFixed(2)} \u00b5s \u2014 ${tailPhrase}.`;

  el.runTag.textContent = `${groups(n)} orders run at seed ${seed}, batches of ${groups(batchSize)}`;
  el.runTag.className = "tag good";
  el.runBtn.disabled = false;

  drawLatencyChart(samplesUs, stats);
});

// ------------------------------------------------------------------- chart

function chartColours() {
  const css = getComputedStyle(document.body);
  const c = (name) => css.getPropertyValue(name).trim();
  return {
    border: c("--border"),
    faint: c("--text-faint"),
    dim: c("--text-dim"),
    text: c("--text"),
    accent: c("--accent"),
    good: c("--good"),
    warn: c("--warn"),
    bad: c("--bad"),
  };
}

// Sizes the backing store to the canvas's actual CSS box times
// devicePixelRatio, so the chart is crisp on a high-DPI display instead of
// a fixed 760x320 store stretched (and blurred) into whatever CSS gives it.
// Returns the CSS-pixel width/height the drawing code should use, since a
// ctx transformed by dpr already maps CSS pixels to backing-store pixels.
function sizeCanvasToContainer(cv) {
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const cssW = Math.max(1, Math.round(rect.width || cv.width));
  const cssH = Math.max(1, Math.round(rect.height || cv.height));
  const backingW = Math.round(cssW * dpr);
  const backingH = Math.round(cssH * dpr);
  if (cv.width !== backingW || cv.height !== backingH) {
    cv.width = backingW;
    cv.height = backingH;
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return { ctx, W: cssW, H: cssH };
}

// Log-x histogram of per-operation cost (averaged over batches), with
// p50/p99/p99.9 batch markers - this is the headline chart of the page.
function drawLatencyChart(samplesUs, stats) {
  const cv = el.latencyChart;
  const col = chartColours();
  if (samplesUs.length === 0) { sizeCanvasToContainer(cv); return; }

  const { buckets, edges, dropped } = logHistogram(samplesUs, 44);
  if (dropped > 0) {
    // Batch means should all be strictly positive; a non-positive sample here
    // means calibration picked too small a batch for this run, not that the
    // data is fine to silently thin out - say so rather than plot a sliver.
    console.warn(`latency chart: ${dropped} of ${samplesUs.length} batch samples were non-positive and are not plotted`);
  }
  const { ctx, W, H } = sizeCanvasToContainer(cv);
  const pad = { l: 46, r: 20, t: 20, b: 40 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const logMin = Math.log10(edges[0]);
  const logMax = Math.log10(edges[edges.length - 1]);
  const xOf = (us) => pad.l + ((Math.log10(us) - logMin) / (logMax - logMin)) * plotW;
  const maxCount = Math.max(1, ...buckets);
  const yOf = (count) => pad.t + (1 - count / maxCount) * plotH;

  // gridlines + log-scale tick labels at powers of ten within range
  ctx.strokeStyle = col.border;
  ctx.fillStyle = col.faint;
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "center";
  const lowPow = Math.floor(logMin);
  const highPow = Math.ceil(logMax);
  for (let p = lowPow; p <= highPow; p++) {
    const us = Math.pow(10, p);
    if (us < edges[0] || us > edges[edges.length - 1]) continue;
    const x = xOf(us);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, H - pad.b);
    ctx.stroke();
    ctx.fillText(us >= 1 ? `${groups(us)}\u00b5s` : `${us.toFixed(2)}\u00b5s`, x, H - pad.b + 14);
  }

  // histogram bars
  ctx.fillStyle = col.accent;
  for (let i = 0; i < buckets.length; i++) {
    const x0 = xOf(edges[i]);
    const x1 = xOf(edges[i + 1]);
    const y = yOf(buckets[i]);
    ctx.fillRect(x0, y, Math.max(1, x1 - x0 - 1), H - pad.b - y);
  }

  // p50 / p99 / p99.9 marker lines
  const markers = [
    { value: stats.p50, label: "p50", colour: col.good },
    { value: stats.p99, label: "p99", colour: col.warn },
    { value: stats.p999, label: "p99.9", colour: col.bad },
  ];
  ctx.textBaseline = "alphabetic";
  markers.forEach((m, i) => {
    if (!(m.value > 0)) return;
    const x = xOf(m.value);
    ctx.strokeStyle = m.colour;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, H - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = m.colour;
    ctx.textAlign = x > W - pad.r - 60 ? "right" : "left";
    // Markers can land close together on the log axis (p99 and p99.9
    // especially, near the right edge) — stagger each label's row so
    // adjacent ones never draw on top of each other.
    ctx.fillText(`${m.label} ${m.value.toFixed(2)}\u00b5s`, x + (ctx.textAlign === "right" ? -6 : 6), pad.t + 12 + i * 13);
  });

  ctx.strokeStyle = col.border;
  ctx.beginPath();
  ctx.moveTo(pad.l, H - pad.b);
  ctx.lineTo(W - pad.r, H - pad.b);
  ctx.stroke();

  ctx.fillStyle = col.dim;
  ctx.textAlign = "center";
  ctx.fillText("per-operation cost, averaged over batches \u2192 (log scale)", (pad.l + W - pad.r) / 2, H - 6);
}
