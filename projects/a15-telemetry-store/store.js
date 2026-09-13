// store.js — an in-memory time-series store: series identified by a metric
// name plus a set of labels, append-only, queryable by label matcher and by
// time window with automatic downsampling. Pure, no DOM.

// ============================================================================
// Label matching.
// ============================================================================

// A matcher is `{ [labelName]: matchSpec }` where matchSpec is either a
// plain string (exact match) or `{ op, value }` with op one of:
//   "="  exact match (same as a plain string)
//   "!=" negative match — label must NOT equal value
//   "*"  wildcard — value is a substring the label must contain
// A metric name matcher goes under the special key "__name__".
export function matchLabels(series, matcher) {
  for (const [key, spec] of Object.entries(matcher)) {
    const actual = key === "__name__" ? series.name : series.labels[key];
    if (typeof spec === "string") {
      if (actual !== spec) return false;
    } else if (spec.op === "=") {
      if (actual !== spec.value) return false;
    } else if (spec.op === "!=") {
      if (actual === spec.value) return false;
    } else if (spec.op === "*") {
      if (typeof actual !== "string" || !actual.includes(spec.value)) return false;
    } else {
      throw new Error(`unknown matcher op: ${spec.op}`);
    }
  }
  return true;
}

// Renders a series' identity the way a real TSDB does: `name{k="v", k2="v2"}`.
export function seriesKey(name, labels) {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`);
  return `${name}{${parts.join(", ")}}`;
}

// ============================================================================
// Store.
// ============================================================================

export class TimeSeriesStore {
  constructor() {
    this.series = new Map(); // key -> { name, labels, samples: [{ts, value}] }
  }

  // Appends one sample. Creates the series on first use. Samples must arrive
  // in non-decreasing ts order per series (a real ingest pipeline enforces
  // this at the write path; this store trusts its caller, same as the wire
  // format in a13 trusts the encoder — it is not re-validated on every write).
  append(name, labels, ts, value) {
    const key = seriesKey(name, labels);
    let s = this.series.get(key);
    if (!s) {
      s = { name, labels, samples: [] };
      this.series.set(key, s);
    }
    s.samples.push({ ts, value });
    return s;
  }

  // All series matching a label matcher (see matchLabels above).
  query(matcher = {}) {
    const out = [];
    for (const s of this.series.values()) {
      if (matchLabels(s, matcher)) out.push(s);
    }
    return out;
  }

  seriesList() {
    return Array.from(this.series.values());
  }
}

// ============================================================================
// Range queries with downsampling.
// ============================================================================

// Splits [from, to) into `bucketCount` equal-width buckets and reduces each
// bucket's samples to {min, max, mean, last, count}. A real dashboard asking
// for a week of one-second samples is asking for 604,800 points — rendering
// that many pixels tells the eye nothing a few hundred buckets would not,
// and it makes every subsequent chart render and re-render slower for no
// visual gain. min/max keep spikes visible even when they are outnumbered
// inside a bucket; mean is what a line chart usually wants; last is what a
// "current value" readout wants without recomputing anything.
export function downsample(samples, from, to, bucketCount) {
  const width = (to - from) / bucketCount;
  const buckets = new Array(bucketCount);
  for (let i = 0; i < bucketCount; i++) {
    buckets[i] = { bucketStart: from + i * width, bucketEnd: from + (i + 1) * width, min: null, max: null, sum: 0, count: 0, last: null, lastTs: -Infinity };
  }
  for (const s of samples) {
    if (s.ts < from || s.ts >= to) continue;
    let idx = width > 0 ? Math.floor((s.ts - from) / width) : 0;
    if (idx >= bucketCount) idx = bucketCount - 1;
    if (idx < 0) idx = 0;
    const b = buckets[idx];
    b.min = b.min === null ? s.value : Math.min(b.min, s.value);
    b.max = b.max === null ? s.value : Math.max(b.max, s.value);
    b.sum += s.value;
    b.count++;
    if (s.ts >= b.lastTs) {
      b.last = s.value;
      b.lastTs = s.ts;
    }
  }
  return buckets.map((b) => ({
    bucketStart: b.bucketStart,
    bucketEnd: b.bucketEnd,
    min: b.min,
    max: b.max,
    mean: b.count > 0 ? b.sum / b.count : null,
    last: b.last,
    count: b.count,
  }));
}

// Returns raw samples in [from, to) if there are few enough to be worth
// plotting one-for-one, otherwise downsampled buckets. `maxRawPoints` is the
// caller's own idea of "few enough" (typically the plot's pixel width).
export function rangeQuery(series, from, to, maxRawPoints = 400) {
  const raw = series.samples.filter((s) => s.ts >= from && s.ts < to);
  if (raw.length <= maxRawPoints) {
    return { downsampled: false, points: raw };
  }
  const bucketCount = maxRawPoints;
  return { downsampled: true, points: downsample(raw, from, to, bucketCount) };
}

// ============================================================================
// Counter-reset-aware rate calculation.
// ============================================================================

// A monotonic counter (interface byte/packet counters, in real telemetry)
// only ever increases between reports — until the device reboots or the
// counter wraps, at which point the next reading is smaller than the last
// one. A naive `(v[i] - v[i-1]) / dt` on that transition produces a huge
// negative "rate", which is nonsense: the counter did not run backwards, it
// restarted from (near) zero. The fix recognised throughout real monitoring
// systems (Prometheus's `rate()`/`increase()` do exactly this): whenever a
// value drops, treat the counter as having reset and count only the
// post-reset increase, not the (negative) raw delta.
export function ratesWithResetHandling(samples) {
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].ts - samples[i - 1].ts) / 1000; // seconds
    if (dt <= 0) continue;
    const raw = samples[i].value - samples[i - 1].value;
    const reset = raw < 0;
    const delta = reset ? samples[i].value : raw; // counter restarted near 0
    out.push({ ts: samples[i].ts, rate: delta / dt, reset });
  }
  return out;
}

// The naive version, kept only so the UI and tests can show the bug side by
// side with the fix above — never used for anything that reports a "real" rate.
export function naiveRates(samples) {
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].ts - samples[i - 1].ts) / 1000;
    if (dt <= 0) continue;
    out.push({ ts: samples[i].ts, rate: (samples[i].value - samples[i - 1].value) / dt });
  }
  return out;
}

// ============================================================================
// Anomaly detection: a threshold heuristic, not ML.
// ============================================================================

// Rolling median absolute deviation (MAD), a robust alternative to a mean
// and standard deviation that a handful of the very anomalies you are
// looking for would otherwise drag around. A point is flagged when it is
// more than `k` "robust standard deviations" (MAD scaled by 1.4826, the
// constant that makes MAD estimate the standard deviation of a normal
// distribution) from the rolling median of the `window` points before it.
// This is deliberately simple and explainable — a reviewer can recompute it
// by hand on a handful of numbers — not a statistical model fit to data,
// still less a learned one.
//
// The rolling window alone misses the one fault this detector exists to
// catch: a *gradual*, sustained drift (a degrading optical receiver losing
// a fraction of a dB per tick). Each new point sits close to the median of
// the points just before it, so the local deviation never grows even as the
// absolute value drifts arbitrarily far from where the signal started — a
// port could fall from -18dBm to the loss-of-signal floor and the rolling
// score would stay near zero throughout. A second comparison, against a
// long-horizon baseline established from the earliest `baselineSize` points
// (assumed representative of the signal's normal operating point), catches
// exactly this: a sustained departure from that fixed baseline scores high
// and stays high, however slowly it got there. A point is flagged if either
// score clears the threshold, so a sharp point outlier (the local check)
// and a slow sustained drift (the baseline check) are both caught.
const MAD_TO_STD = 1.4826;

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// median absolute deviation, scaled to a robust standard deviation, floored
// at `minDeviation` so a perfectly flat window does not divide by zero.
function robustScale(values, minDeviation) {
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  return { med, scale: Math.max(mad * MAD_TO_STD, minDeviation) };
}

// `plausibleMin`/`plausibleMax`, if given, are a hard physical bound (e.g. a
// PON receiver's -8..-28dBm normal operating band) rather than a statistical
// one: a baseline that has itself already settled at an implausible extreme
// (a link that degraded before the baseline window was established, or one
// that has been sitting at the loss-of-signal floor for the whole window
// on screen) has no "normal" left in its own recent history for either the
// local or the drift check to compare against — this catches that case by
// asking "is this value one a healthy link could ever report", independent
// of what the data itself looks like.
export function detectAnomalies(samples, { window = 12, k = 5, minDeviation = 0, baselineSize = 30, plausibleMin = -Infinity, plausibleMax = Infinity } = {}) {
  const flags = new Array(samples.length).fill(false);
  const scores = new Array(samples.length).fill(0);

  let baseline = null;
  if (samples.length >= Math.min(baselineSize, 10)) {
    const baseValues = samples.slice(0, Math.min(baselineSize, samples.length)).map((s) => s.value);
    baseline = robustScale(baseValues, minDeviation);
  }

  for (let i = 0; i < samples.length; i++) {
    const start = Math.max(0, i - window);
    let localScore = 0;
    if (i - start >= Math.min(window, 5)) {
      const history = samples.slice(start, i).map((s) => s.value);
      const { med, scale } = robustScale(history, minDeviation);
      const deviation = Math.abs(samples[i].value - med);
      localScore = scale > 0 ? deviation / scale : (deviation > 0 ? Infinity : 0);
    }
    let driftScore = 0;
    if (baseline && baseline.scale > 0) {
      driftScore = Math.abs(samples[i].value - baseline.med) / baseline.scale;
    }
    const implausible = samples[i].value < plausibleMin || samples[i].value > plausibleMax;
    const score = Math.max(localScore, driftScore, implausible ? k : 0);
    scores[i] = score;
    if (score >= k) flags[i] = true;
  }
  return { flags, scores };
}
