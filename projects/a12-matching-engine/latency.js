// Latency measurement primitives: a recorder for per-operation timings, and
// the statistics that turn a pile of nanosecond samples into "what should I
// worry about". Pure, no DOM - importable from Node and the browser.

// Preallocated: pushing onto a growing array during measurement can trigger
// a backing-store reallocation (and, on some engines, a GC pause) in the
// middle of the very operation you are timing, which perturbs the
// measurement you are trying to take. A Float64Array of a fixed capacity,
// written by index, allocates once up front and never again while the
// recorder is running.
export class LatencyRecorder {
  constructor(capacity) {
    this.capacity = capacity;
    this.samples = new Float64Array(capacity);
    this.count = 0;
  }

  record(millis) {
    if (this.count < this.capacity) this.samples[this.count] = millis;
    this.count++;
  }

  // Times `fn()` with performance.now() and records the elapsed ms. Returns
  // fn's return value so a caller can measure without changing its own
  // control flow.
  time(fn) {
    const t0 = performance.now();
    const result = fn();
    this.record(performance.now() - t0);
    return result;
  }

  reset() { this.count = 0; }

  // Live samples only, as a plain array (drops unused preallocated tail).
  toArray() {
    return Array.from(this.samples.subarray(0, Math.min(this.count, this.capacity)));
  }
}

// Detects the actual granularity of performance.now() in THIS runtime by
// watching for the smallest non-zero gap between successive calls. Browsers
// deliberately coarsen the clock (Spectre-era side-channel mitigation,
// typically to a 0.1ms or 1ms tick) - a build that assumes nanosecond
// resolution silently produces a three-value "distribution" that is really
// just the clock's own step function. `now` is injectable for tests; real
// callers use the default (performance.now itself).
export function calibrateClockResolution(now = () => performance.now(), maxSamples = 30, maxIterations = 200000) {
  const deltas = [];
  let prev = now();
  for (let i = 0; i < maxIterations && deltas.length < maxSamples; i++) {
    const t = now();
    const d = t - prev;
    if (d > 0) deltas.push(d);
    prev = t;
  }
  // The loop itself never observed a tick (clock frozen, or maxIterations was
  // too small for a very coarse clock) - 0 signals "unknown", not "perfect".
  if (deltas.length === 0) return 0;
  deltas.sort((a, b) => a - b);
  return deltas[0];
}

// Finds the smallest batch size K such that timing K consecutive calls to
// `fn` clears the clock's own tick by a comfortable margin, so dividing the
// batch's elapsed time by K yields a per-operation figure that is not just
// quantisation noise. Doubles (geometrically grows) K until a batch takes at
// least `targetMs` and at least ten clock ticks. `fn` runs for real as part
// of this search - callers measuring a stateful operation should calibrate
// against a throwaway instance, not the one being measured for the record.
export function calibrateBatchSize(fn, { tickMs = null, targetMs = 1, now = () => performance.now(), maxK = 1 << 20 } = {}) {
  const tick = tickMs ?? calibrateClockResolution(now);
  const target = Math.max(targetMs, tick * 10);
  let k = 1;
  while (k < maxK) {
    const t0 = now();
    for (let i = 0; i < k; i++) fn();
    const elapsed = now() - t0;
    if (elapsed >= target) return k;
    k = elapsed > 0 ? Math.max(k + 1, Math.ceil(k * (target / elapsed) * 1.3)) : k * 4;
  }
  return maxK;
}

// Percentiles, computed from a sorted COPY of the input (never mutates the
// caller's array). Convention: nearest-rank with linear interpolation
// between the two bracketing samples ("R-7"/Excel PERCENTILE.INC, the same
// one NumPy's default and most APM tools use) - rank = p * (n - 1), then
// interpolate between floor(rank) and ceil(rank). This is documented here
// because percentile conventions disagree at the edges and silently produce
// different numbers: for p99.9 on a 1000-element array (indices 0..999),
// rank = 0.999 * 999 = 998.001, which interpolates 99.9% of the way between
// samples[998] and samples[999] - not simply "index 999", which is why a
// 1000-sample p99.9 is not identical to the max.
function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

// Divide a/b, guarding the case that would otherwise print the literal
// string "Infinity" (or "NaN") straight into the DOM - a denominator of
// zero (or non-finite) means "not computable", not "unboundedly large".
// `fallback` is a caller-supplied number or string to show instead.
export function safeRatio(a, b, fallback = null) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return fallback;
  return a / b;
}

// samples: array (or array-like) of numbers, any unit - caller's responsibility.
export function computeStats(samples) {
  const n = samples.length;
  if (n === 0) {
    return { count: 0, min: NaN, max: NaN, mean: NaN, p50: NaN, p90: NaN, p99: NaN, p999: NaN };
  }
  const sorted = Array.from(samples).sort((a, b) => a - b);
  let sum = 0;
  for (const s of sorted) sum += s;
  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    mean: sum / n,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    p999: percentile(sorted, 0.999),
  };
}

// Log-scale histogram bucketer: buckets are evenly spaced in log-space
// between the smallest positive sample and the max, so a latency
// distribution spanning several orders of magnitude (sub-microsecond
// touches, millisecond outliers) is legible instead of one tall spike at
// the left edge of a linear histogram.
// log10 is undefined at zero and below, so those samples cannot appear in a
// log-space bucketing - but discarding them silently is how the earlier bug
// hid itself (99.9% of a batch's samples vanishing without a trace anywhere
// in the returned shape). `dropped` makes that count visible to the caller
// instead, so a chart that is only plotting a sliver of its input says so.
export function logHistogram(samples, bucketCount = 40) {
  const all = Array.from(samples);
  const positive = all.filter((s) => s > 0);
  const dropped = all.length - positive.length;
  if (positive.length === 0) return { buckets: [], edges: [], min: 0, max: 0, dropped };

  const min = Math.min(...positive);
  const max = Math.max(...positive);
  const logMin = Math.log10(min);
  const logMax = Math.log10(Math.max(max, min * 1.0000001)); // guard against a zero-width range
  const width = (logMax - logMin) / bucketCount;

  const buckets = new Array(bucketCount).fill(0);
  for (const s of positive) {
    const idx = width > 0 ? Math.min(bucketCount - 1, Math.floor((Math.log10(s) - logMin) / width)) : 0;
    buckets[idx]++;
  }
  const edges = new Array(bucketCount + 1);
  for (let i = 0; i <= bucketCount; i++) edges[i] = Math.pow(10, logMin + i * width);

  return { buckets, edges, min, max, dropped };
}
