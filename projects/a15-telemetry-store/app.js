// app.js — DOM and canvas only. All storage, compression, generation and
// detection logic lives in compress.js / store.js / stream.js, which are
// plain modules importable from Node too (see the *.test.js files).
import { compressSeries, NAIVE_BYTES_PER_SAMPLE } from "./compress.js";
import { TimeSeriesStore, matchLabels, rangeQuery, ratesWithResetHandling, naiveRates, detectAnomalies } from "./store.js";
import { generate } from "./stream.js";

const $ = (id) => document.getElementById(id);

const el = {
  streamBtn: $("stream-btn"),
  seedInput: $("seed-input"),
  streamStatus: $("stream-status"),
  compressionTag: $("compression-tag"),
  statBytesPerSample: $("stat-bytes-per-sample"),
  statBitsPerSample: $("stat-bits-per-sample"),
  statRatio: $("stat-ratio"),
  tsBreakdown: $("ts-breakdown"),
  tsBar: $("ts-bar"),
  valBreakdown: $("val-breakdown"),
  valBar: $("val-bar"),
  compressionNote: $("compression-note"),

  windowSelect: $("window-select"),
  chartWindowNote: $("chart-window-note"),
  advanceBtn: $("advance-btn"),
  advanceStatus: $("advance-status"),
  chartThroughput: $("chart-throughput"),
  chartLight: $("chart-light"),
  chartCrc: $("chart-crc"),

  faultDegradeBtn: $("fault-degrade-btn"),
  faultCrcBtn: $("fault-crc-btn"),
  faultRebootBtn: $("fault-reboot-btn"),
  faultResetBtn: $("fault-reset-btn"),
  faultStatus: $("fault-status"),
  chartRateFixed: $("chart-rate-fixed"),
  chartRateNaive: $("chart-rate-naive"),
  anomalyStatus: $("anomaly-status"),

  queryMetric: $("query-metric"),
  queryNode: $("query-node"),
  queryPort: $("query-port"),
  queryBtn: $("query-btn"),
  queryResults: $("query-results"),
};

const groups = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
// Guard against a zero (or non-finite) denominator reaching the DOM as the
// literal string "Infinity" — a sibling project in this portfolio shipped
// exactly that bug once.
const safeRatio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null);

// ============================================================================
// 1. Headline compression panel.
// ============================================================================

// A wider, denser topology than the live-chart section below, so the
// headline figure is measured over a realistic fleet, not the handful of
// ports the interactive charts track.
const HEADLINE_TOPOLOGY = { nodeCount: 3, portsPerNode: 4, sampleCount: 2000, intervalMs: 10000 };

function runCompressionMeasurement(seed) {
  const { samplesByKey } = generate({ seed, ...HEADLINE_TOPOLOGY });
  let totalBytes = 0;
  let totalNaiveBytes = 0;
  let totalSamples = 0;
  let oneBitTs = 0;
  let tsOpportunities = 0;
  let zeroXorVals = 0;
  let valOpportunities = 0;

  for (const series of samplesByKey.values()) {
    for (const metric of Object.keys(series)) {
      const samples = series[metric];
      if (samples.length === 0) continue;
      const result = compressSeries(samples);
      totalBytes += result.bytes.length;
      totalNaiveBytes += samples.length * NAIVE_BYTES_PER_SAMPLE;
      totalSamples += samples.length;
      oneBitTs += result.oneBitTimestamps;
      tsOpportunities += Math.max(0, samples.length - 2);
      zeroXorVals += result.zeroXorValues;
      valOpportunities += Math.max(0, samples.length - 1);
    }
  }

  return { totalBytes, totalNaiveBytes, totalSamples, oneBitTs, tsOpportunities, zeroXorVals, valOpportunities };
}

function renderCompressionResult(r) {
  const bytesPerSample = safeRatio(r.totalBytes, r.totalSamples);
  const bitsPerSample = bytesPerSample !== null ? bytesPerSample * 8 : null;
  const ratio = safeRatio(r.totalBytes, r.totalNaiveBytes);

  el.statBytesPerSample.textContent = bytesPerSample !== null ? bytesPerSample.toFixed(2) : "n/a";
  el.statBitsPerSample.textContent = bitsPerSample !== null ? bitsPerSample.toFixed(1) : "n/a";
  el.statRatio.textContent = ratio !== null ? `${(ratio * 100).toFixed(1)}%` : "n/a";

  const tsFrac = safeRatio(r.oneBitTs, r.tsOpportunities);
  const valFrac = safeRatio(r.zeroXorVals, r.valOpportunities);
  el.tsBreakdown.textContent = tsFrac !== null
    ? `${groups(r.oneBitTs)} of ${groups(r.tsOpportunities)} timestamps (${(tsFrac * 100).toFixed(1)}%) cost exactly one bit — the sampling interval is regular enough that delta-of-delta collapses to zero almost every time.`
    : "not enough samples to measure.";
  el.tsBar.style.width = `${tsFrac !== null ? (tsFrac * 100).toFixed(1) : 0}%`;

  el.valBreakdown.textContent = valFrac !== null
    ? `${groups(r.zeroXorVals)} of ${groups(r.valOpportunities)} values (${(valFrac * 100).toFixed(1)}%) were bit-for-bit identical to the previous sample and cost one bit; the rest were XOR-encoded around their leading/trailing zero windows.`
    : "not enough samples to measure.";
  el.valBar.style.width = `${valFrac !== null ? (valFrac * 100).toFixed(1) : 0}%`;

  el.compressionTag.textContent = `${groups(r.totalSamples)} samples across ${HEADLINE_TOPOLOGY.nodeCount * HEADLINE_TOPOLOGY.portsPerNode} ports \u00d7 5 metrics`;
  el.compressionTag.className = "tag good";

  const naivePerSample = NAIVE_BYTES_PER_SAMPLE;
  // At a 10s sampling interval this demo uses, one port emits 5 metrics x
  // 8,640 samples/day = 43,200 a day; across the headline topology's 12
  // ports that is ~518,000 a day fleet-wide — real, not the "a million a
  // day per port" this line used to claim (which no 10s-interval port
  // reaches: that needs an interval under 1s).
  const perPortPerDay = Math.round(86400000 / HEADLINE_TOPOLOGY.intervalMs) * 5;
  const fleetPerDay = perPortPerDay * HEADLINE_TOPOLOGY.nodeCount * HEADLINE_TOPOLOGY.portsPerNode;
  el.compressionNote.textContent =
    `Measured just now, live, on this generated fleet: ${groups(r.totalBytes)} bytes stored for ` +
    `${groups(r.totalSamples)} samples that a naive fixed-width record would need ${groups(r.totalNaiveBytes)} ` +
    `bytes for (${naivePerSample} bytes/sample). That is ${bytesPerSample !== null ? bytesPerSample.toFixed(2) : "?"} ` +
    `bytes/sample here — ${groups(perPortPerDay)} measurements a day per port at this sampling interval, ` +
    `${groups(fleetPerDay)} a day across this fleet's ${HEADLINE_TOPOLOGY.nodeCount * HEADLINE_TOPOLOGY.portsPerNode} ports, ` +
    `stored in a fraction of the space, and every one of them still answerable by a range query below.`;
}

el.streamBtn.addEventListener("click", () => {
  const seed = Math.floor(Number(el.seedInput.value)) || 1;
  el.streamStatus.textContent = "streaming and compressing...";
  // requestAnimationFrame so "streaming..." actually paints before the
  // (synchronous, sub-second) measurement work runs.
  requestAnimationFrame(() => {
    const r = runCompressionMeasurement(seed);
    renderCompressionResult(r);
    el.streamStatus.textContent = `measured live at seed ${seed}.`;
  });
});

// Populate on load so the page never opens on an empty panel.
renderCompressionResult(runCompressionMeasurement(Number(el.seedInput.value) || 7));

// ============================================================================
// 2. Live section: a smaller topology the fault-injection controls act on.
// ============================================================================

const LIVE_INTERVAL_MS = 30000; // 30s samples
// A rolling window alone tracks a slow ramp and never flags it, however far
// it has drifted - see store.js's detectAnomalies. -25dBm is comfortably
// inside the -30dBm loss-of-signal floor stream.js clamps at (real GPON Rx
// is normally around -8 to -28dBm), so a plausibility floor here catches a
// degraded link that has already been sitting there for the whole window on
// screen, which the rolling and baseline checks alone cannot.
const LIGHT_PLAUSIBLE_MIN_DBM = -25;
const LIVE_TOPOLOGY = { seed: 42, nodeCount: 2, portsPerNode: 2, intervalMs: LIVE_INTERVAL_MS };
const THROUGHPUT_KEY = "aar-olt-01/1/1/1";
const CRC_KEY = "aar-olt-01/1/1/2";

const live = {
  tickCount: 200, // ~100 minutes of history to start with, so charts are never empty
  faults: [],
  data: null, // generate() result
  store: null,
};

function rebuildLive() {
  live.data = generate({ ...LIVE_TOPOLOGY, sampleCount: live.tickCount, faults: live.faults });
  live.store = new TimeSeriesStore();
  for (const [key, series] of live.data.samplesByKey) {
    const [node, ...portParts] = key.split("/");
    const port = portParts.join("/");
    for (const metric of Object.keys(series)) {
      for (const s of series[metric]) {
        live.store.append(metric, { node, port }, s.ts, s.value);
      }
    }
  }
}

rebuildLive();

// ---------------------------------------------------------------- canvas helpers

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
    alt: c("--alt"),
  };
}

// Sizes the backing store to the canvas's actual CSS box times
// devicePixelRatio, so charts render crisp instead of blurry, and axis
// labels are not clipped by a store sized to stale CSS.
function sizeCanvasToContainer(cv) {
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const cssW = Math.max(1, Math.round(rect.width || cv.width || 300));
  const cssH = Math.max(1, Math.round(rect.height || cv.height || 200));
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

const compactNumber = (n) => {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}G`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  if (abs >= 1) return n.toFixed(1);
  return n.toFixed(3);
};

function formatClock(ts) {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// A generic line/band chart: draws `series` = [{ points: [{ts, value}], colour, label }]
// on shared axes, with optional min/max bands (points may instead carry
// {ts, min, max, mean} for a downsampled series — drawn as a shaded band
// plus a mean line) and optional highlighted points (anomaly markers).
function drawChart(cv, series, { yLabel = "", highlightFn = null, downsampled = false } = {}) {
  const col = chartColours();
  const { ctx, W, H } = sizeCanvasToContainer(cv);
  const pad = { l: 52, r: 14, t: 12, b: 26 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) {
    ctx.fillStyle = col.faint;
    ctx.font = "12px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText("no data in this window", W / 2, H / 2);
    return;
  }

  const isBucket = "mean" in allPoints[0] && allPoints[0].mean !== undefined && !("value" in allPoints[0]);
  const valueOf = (p) => (isBucket ? p.mean : p.value);
  const minOf = (p) => (isBucket && p.min !== null ? p.min : valueOf(p));
  const maxOf = (p) => (isBucket && p.max !== null ? p.max : valueOf(p));
  const tsOf = (p) => (isBucket ? (p.bucketStart + p.bucketEnd) / 2 : p.ts);

  const tMin = Math.min(...allPoints.map(tsOf));
  const tMax = Math.max(...allPoints.map(tsOf));
  let vMin = Math.min(...allPoints.filter((p) => valueOf(p) !== null).map(minOf));
  let vMax = Math.max(...allPoints.filter((p) => valueOf(p) !== null).map(maxOf));
  if (vMin === vMax) { vMin -= 1; vMax += 1; }
  const vPad = (vMax - vMin) * 0.08;
  vMin -= vPad;
  vMax += vPad;

  const xOf = (ts) => pad.l + (tMax > tMin ? ((ts - tMin) / (tMax - tMin)) * plotW : plotW / 2);
  const yOf = (v) => pad.t + (1 - (v - vMin) / (vMax - vMin)) * plotH;

  // gridlines + y-axis labels
  ctx.strokeStyle = col.border;
  ctx.fillStyle = col.faint;
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = vMin + (i / yTicks) * (vMax - vMin);
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
    ctx.fillText(compactNumber(v), pad.l - 6, y);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(formatClock(tMin), pad.l + 4, H - 8);
  ctx.fillText(formatClock(tMax), W - pad.r - 4, H - 8);

  for (const s of series) {
    if (s.points.length === 0) continue;
    // min/max band, only meaningful for a downsampled series
    if (isBucket) {
      ctx.fillStyle = s.colour + "33";
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = xOf(tsOf(p));
        const y = yOf(maxOf(p));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      for (let i = s.points.length - 1; i >= 0; i--) {
        const p = s.points[i];
        ctx.lineTo(xOf(tsOf(p)), yOf(minOf(p)));
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = s.colour;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const v = valueOf(p);
      if (v === null) return;
      const x = xOf(tsOf(p));
      const y = yOf(v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    if (highlightFn) {
      ctx.fillStyle = col.bad;
      for (const p of s.points) {
        if (!highlightFn(p)) continue;
        const v = valueOf(p);
        if (v === null) continue;
        ctx.beginPath();
        ctx.arc(xOf(tsOf(p)), yOf(v), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.strokeStyle = col.border;
  ctx.beginPath();
  ctx.moveTo(pad.l, H - pad.b);
  ctx.lineTo(W - pad.r, H - pad.b);
  ctx.stroke();

  if (downsampled) {
    ctx.fillStyle = col.warn;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.fillText("downsampled (min/max band + mean)", W - pad.r, pad.t + 10);
  }
}

// ---------------------------------------------------------------- rendering the live section

function currentWindowMs() {
  return Number(el.windowSelect.value);
}

function latestTs() {
  const anySeries = live.data.samplesByKey.get(THROUGHPUT_KEY).rx_bytes;
  return anySeries.length ? anySeries[anySeries.length - 1].ts : LIVE_TOPOLOGY.intervalMs;
}

function renderLiveCharts() {
  const windowMs = currentWindowMs();
  const to = latestTs() + LIVE_INTERVAL_MS;
  const from = to - windowMs;
  const col = chartColours();

  // throughput: reset-aware rate of rx_bytes, in bytes/sec, converted to Mbit/s
  const rxSamples = live.data.samplesByKey.get(THROUGHPUT_KEY).rx_bytes.filter((s) => s.ts >= from - LIVE_INTERVAL_MS && s.ts < to);
  const rates = ratesWithResetHandling(rxSamples).map((r) => ({ ts: r.ts, value: (r.rate * 8) / 1e6 }));
  const throughputSeries = { samples: rates };
  const throughputQ = rangeQuery(throughputSeries, from, to, 240);
  drawChart(el.chartThroughput, [{ points: throughputQ.points, colour: col.accent, label: "Mbit/s" }], { downsampled: throughputQ.downsampled });

  // light level, with anomaly highlighting
  const lightSeries = live.store.query({ __name__: "light_dbm", node: "aar-olt-01", port: "1/1/1" })[0];
  const lightQ = rangeQuery(lightSeries, from, to, 240);
  let lightHighlight = null;
  if (!lightQ.downsampled) {
    // Light readings are quantised to 0.1dB (see stream.js) - a flat run of
    // identical values makes the rolling MAD legitimately zero, and without
    // a floor a genuinely quiet signal would flag its own quantisation step
    // as an infinite-sigma anomaly. minDeviation floors the scale at that
    // same 0.1dB the sensor itself cannot resolve below.
    const { flags } = detectAnomalies(lightQ.points, { window: 12, k: 5, minDeviation: 0.1, plausibleMin: LIGHT_PLAUSIBLE_MIN_DBM });
    lightHighlight = (p) => flags[lightQ.points.indexOf(p)];
  }
  drawChart(el.chartLight, [{ points: lightQ.points, colour: col.warn, label: "dBm" }], { downsampled: lightQ.downsampled, highlightFn: lightHighlight });

  // CRC errors (cumulative), on the port the burst is injected into
  const crcSeries = live.store.query({ __name__: "crc_errors", node: "aar-olt-01", port: "1/1/2" })[0];
  const crcQ = rangeQuery(crcSeries, from, to, 240);
  drawChart(el.chartCrc, [{ points: crcQ.points, colour: col.bad, label: "errors" }], { downsampled: crcQ.downsampled });

  el.chartWindowNote.textContent = `window: ${new Date(from).toISOString().slice(11, 16)}\u2013${new Date(to).toISOString().slice(11, 16)} UTC (${groups(windowMs / 60000)} min) \u00b7 ${throughputQ.downsampled ? "downsampled" : "raw points"}`;

  renderRateCharts(from, to, col);
  renderAnomalyStatus(lightQ.points);
}

function renderRateCharts(from, to, col) {
  const rxSamples = live.data.samplesByKey.get(THROUGHPUT_KEY).rx_bytes.filter((s) => s.ts >= from - LIVE_INTERVAL_MS && s.ts < to);
  const rateResults = ratesWithResetHandling(rxSamples);
  const fixed = rateResults.map((r) => ({ ts: r.ts, value: r.rate }));
  const naive = naiveRates(rxSamples).map((r) => ({ ts: r.ts, value: r.rate }));

  drawChart(el.chartRateFixed, [{ points: fixed, colour: col.good }]);
  // The reset marker needs the reset flag from ratesWithResetHandling, which
  // drawChart's generic {ts, value} points do not carry — draw it as a
  // second pass over the same axes instead of widening drawChart's contract
  // for one caller.
  markResets(el.chartRateFixed, fixed, rateResults.map((r) => r.reset), col.bad);

  drawChart(el.chartRateNaive, [{ points: naive, colour: col.bad }]);
}

// Draws a small marker under any point flagged as a reset, reusing the axes
// drawChart just computed by recomputing them identically — kept separate
// from drawChart itself so a plain series chart never carries this concept.
function markResets(cv, points, resetFlags, colour) {
  if (points.length === 0) return;
  const ctx = cv.getContext("2d");
  const rect = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = rect.width, H = rect.height;
  const pad = { l: 52, r: 14, t: 12, b: 26 };
  const plotW = W - pad.l - pad.r;
  const tMin = Math.min(...points.map((p) => p.ts));
  const tMax = Math.max(...points.map((p) => p.ts));
  const xOf = (ts) => pad.l + (tMax > tMin ? ((ts - tMin) / (tMax - tMin)) * plotW : plotW / 2);
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = colour;
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "center";
  points.forEach((p, i) => {
    if (!resetFlags[i]) return;
    const x = xOf(p.ts);
    ctx.beginPath();
    ctx.moveTo(x, H - 26);
    ctx.lineTo(x, 12);
    ctx.strokeStyle = colour;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText("reset", x, 10);
  });
  ctx.restore();
}

function renderAnomalyStatus(lightPoints) {
  const { flags, scores } = detectAnomalies(lightPoints, { window: 12, k: 5, minDeviation: 0.1, plausibleMin: LIGHT_PLAUSIBLE_MIN_DBM });
  const flaggedCount = flags.filter(Boolean).length;
  if (flaggedCount === 0) {
    el.anomalyStatus.textContent = "Anomaly detector (rolling median \u00b1 5\u00d7 robust deviation) on the light-level series: nothing flagged \u2014 the signal is within its own recent noise band.";
  } else {
    const worst = scores.reduce((best, s, i) => (s > scores[best] ? i : best), 0);
    const worstScore = scores[worst];
    // A perfectly flat window (mad === 0) makes the raw score infinite - that
    // is genuinely "unboundedly far outside a silent baseline", not a number
    // to print, so it gets its own honest phrase instead of "Infinity".
    const worstLabel = Number.isFinite(worstScore) ? `${worstScore.toFixed(1)}\u00d7 the rolling robust spread` : "far outside an otherwise perfectly flat baseline";
    el.anomalyStatus.textContent = `Anomaly detector: ${flaggedCount} point(s) flagged on the light-level series \u2014 worst deviation ${worstLabel}. This is a threshold heuristic (median + scaled median-absolute-deviation), not a learned model.`;
  }
}

renderLiveCharts();

el.windowSelect.addEventListener("change", renderLiveCharts);

el.advanceBtn.addEventListener("click", () => {
  live.tickCount += 50;
  rebuildLive();
  renderLiveCharts();
  el.advanceStatus.textContent = `${groups(live.tickCount)} samples generated so far.`;
});

// ---------------------------------------------------------------- fault injection

el.faultDegradeBtn.addEventListener("click", () => {
  live.faults.push({ atTick: live.tickCount, node: "aar-olt-01", port: "1/1/1", type: "degrade", perTickDb: 0.2 });
  live.tickCount += 30;
  rebuildLive();
  renderLiveCharts();
  el.faultStatus.textContent = "optical level on aar-olt-01/1/1/1 now degrading each tick — watch the light chart and the anomaly status below it.";
});

el.faultCrcBtn.addEventListener("click", () => {
  live.faults.push({ atTick: live.tickCount, node: "aar-olt-01", port: "1/1/2", type: "crcBurst", ticks: 15 });
  live.tickCount += 20;
  rebuildLive();
  renderLiveCharts();
  el.faultStatus.textContent = "CRC error burst injected on aar-olt-01/1/1/2 — watch the CRC chart step up.";
});

el.faultRebootBtn.addEventListener("click", () => {
  live.faults.push({ atTick: live.tickCount + 1, node: "aar-olt-01", port: "1/1/1", type: "reboot" });
  live.tickCount += 10;
  rebuildLive();
  renderLiveCharts();
  el.faultStatus.textContent = "node aar-olt-01 rebooted: rx_bytes on 1/1/1 reset to zero. The reset-aware rate chart stays sane; the naive one spikes hugely negative — that is the bug this store avoids.";
});

el.faultResetBtn.addEventListener("click", () => {
  live.tickCount = 200;
  live.faults = [];
  rebuildLive();
  renderLiveCharts();
  el.faultStatus.textContent = "simulation reset.";
});

// ============================================================================
// 3. Query panel.
// ============================================================================

function parseMatcherInput(raw) {
  const v = raw.trim();
  if (v === "") return undefined;
  if (v.startsWith("!=")) return { op: "!=", value: v.slice(2) };
  if (v.startsWith("*")) return { op: "*", value: v.slice(1) };
  return v;
}

function runQuery() {
  const matcher = {};
  const metric = el.queryMetric.value.trim();
  if (metric) matcher.__name__ = metric;
  const node = parseMatcherInput(el.queryNode.value);
  if (node !== undefined) matcher.node = node;
  const port = parseMatcherInput(el.queryPort.value);
  if (port !== undefined) matcher.port = port;

  const matches = live.store.seriesList().filter((s) => matchLabels(s, matcher));
  if (matches.length === 0) {
    el.queryResults.innerHTML = `<p class="faint">No series match that matcher.</p>`;
    return;
  }
  el.queryResults.innerHTML = matches
    .map((s) => {
      const last = s.samples[s.samples.length - 1];
      return `<div class="query-row mono">${s.name}{node="${s.labels.node}", port="${s.labels.port}"} <span class="faint">\u2014 ${groups(s.samples.length)} samples, last = ${compactNumber(last?.value ?? NaN)}</span></div>`;
    })
    .join("");
}

el.queryBtn.addEventListener("click", runQuery);
runQuery();
