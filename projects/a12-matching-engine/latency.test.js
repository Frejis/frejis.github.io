import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LatencyRecorder,
  computeStats,
  logHistogram,
  safeRatio,
  calibrateClockResolution,
  calibrateBatchSize,
} from "./latency.js";

test("LatencyRecorder records samples up to its capacity without allocating during recording", () => {
  const rec = new LatencyRecorder(5);
  for (let i = 0; i < 5; i++) rec.record(i + 1);
  assert.deepEqual(rec.toArray(), [1, 2, 3, 4, 5]);
  assert.equal(rec.count, 5);
});

test("LatencyRecorder.time measures and returns the function's result", () => {
  const rec = new LatencyRecorder(10);
  const result = rec.time(() => 41 + 1);
  assert.equal(result, 42);
  assert.equal(rec.count, 1);
  assert.ok(rec.samples[0] >= 0);
});

test("LatencyRecorder.reset clears the count without touching capacity", () => {
  const rec = new LatencyRecorder(4);
  rec.record(1);
  rec.record(2);
  rec.reset();
  assert.equal(rec.count, 0);
  assert.equal(rec.capacity, 4);
});

test("percentiles on 1..1000 match the documented linear-interpolation convention", () => {
  const samples = Array.from({ length: 1000 }, (_, i) => i + 1); // 1..1000
  const stats = computeStats(samples);
  // rank = p * (n - 1); p50 -> rank 499.5 -> halfway between samples[499]=500 and samples[500]=501
  assert.equal(stats.p50, 500.5);
  // p99 -> rank 0.99 * 999 = 989.01 -> samples[989]=990 + 0.01*(samples[990]-samples[989])
  assert.equal(stats.p99, 990.01);
  // p99.9 -> rank 0.999 * 999 = 998.001 -> samples[998]=999 + 0.001*(samples[999]-samples[998])
  assert.ok(Math.abs(stats.p999 - 999.001) < 1e-9);
  assert.equal(stats.min, 1);
  assert.equal(stats.max, 1000);
  assert.equal(stats.mean, 500.5);
});

test("computeStats handles a single-element and an empty array", () => {
  assert.equal(computeStats([42]).p99, 42);
  assert.equal(computeStats([42]).min, 42);
  const empty = computeStats([]);
  assert.equal(empty.count, 0);
  assert.ok(Number.isNaN(empty.p50));
});

test("computeStats does not mutate the input array", () => {
  const samples = [5, 3, 1, 4, 2];
  computeStats(samples);
  assert.deepEqual(samples, [5, 3, 1, 4, 2]);
});

test("logHistogram buckets samples across a wide range without a huge single spike at the edges", () => {
  const samples = [0.001, 0.01, 0.1, 1, 10, 100];
  const { buckets, edges } = logHistogram(samples, 6);
  assert.equal(buckets.length, 6);
  assert.equal(buckets.reduce((a, b) => a + b, 0), samples.length);
  assert.equal(edges.length, 7);
  // edges must be strictly increasing (proper log spacing)
  for (let i = 1; i < edges.length; i++) assert.ok(edges[i] > edges[i - 1]);
});

test("logHistogram ignores non-positive samples (log of zero/negative is undefined)", () => {
  const { buckets } = logHistogram([0, -1, 5, 10], 4);
  assert.equal(buckets.reduce((a, b) => a + b, 0), 2);
});

test("logHistogram on identical samples does not divide by a zero-width range", () => {
  const { buckets } = logHistogram([5, 5, 5, 5], 4);
  assert.equal(buckets.reduce((a, b) => a + b, 0), 4);
  assert.equal(buckets[0], 4);
});

test("safeRatio divides normally when the denominator is a genuine non-zero number", () => {
  assert.equal(safeRatio(10, 2), 5);
  assert.equal(safeRatio(1, 4), 0.25);
});

test("safeRatio never returns Infinity/-Infinity/NaN - the string that must not reach the DOM", () => {
  assert.equal(safeRatio(10, 0), null);
  assert.equal(safeRatio(-10, 0), null);
  assert.equal(safeRatio(0, 0), null);
  assert.equal(safeRatio(NaN, 5), null);
  assert.equal(safeRatio(5, NaN), null);
  // fallback is whatever the caller wants shown instead of a number
  assert.equal(safeRatio(10, 0, "n/a"), "n/a");
});

test("calibrateClockResolution reports the smallest non-zero gap a fake clock produces", () => {
  // A clock that steps in fixed 0.1ms increments, like a coarsened
  // performance.now() - the calibration must recover exactly that step.
  let t = 0;
  const fakeNow = () => { t += 0.1; return t; };
  const resolution = calibrateClockResolution(fakeNow, 10, 1000);
  assert.ok(Math.abs(resolution - 0.1) < 1e-9);
});

test("calibrateClockResolution returns 0 (unknown) if the clock never ticks within the iteration budget", () => {
  const frozenNow = () => 42;
  assert.equal(calibrateClockResolution(frozenNow, 10, 50), 0);
});

test("calibrateBatchSize picks a K that clears a coarse clock's tick by a comfortable margin", () => {
  // Simulate a clock coarsened to 0.1ms ticks (quantises any elapsed time to
  // the nearest 0.1ms) timing a fast no-op - the batch size returned must be
  // large enough that a batch's elapsed time is not itself quantisation noise.
  let raw = 0;
  const coarsen = (x) => Math.round(x / 0.1) * 0.1;
  const fakeNow = () => coarsen(raw);
  const k = calibrateBatchSize(() => { raw += 0.0002; }, { tickMs: 0.1, targetMs: 1, now: fakeNow, maxK: 1 << 20 });
  // targetMs=1 with a 0.1ms tick means the real floor is max(1, 0.1*10) = 1ms;
  // at ~0.0002ms of "work" per call that is at least ~5000 calls.
  assert.ok(k >= 4000, `expected a batch size in the thousands, got ${k}`);
});

test("calibrateBatchSize falls back to the caller's targetMs when tickMs is not supplied", () => {
  let raw = 0;
  const fakeNow = () => raw;
  const k = calibrateBatchSize(() => { raw += 1; }, { tickMs: 0, targetMs: 5, now: fakeNow });
  assert.ok(k >= 5);
});

test("logHistogram reports how many non-positive samples it dropped, rather than silently discarding them", () => {
  const { buckets, dropped } = logHistogram([0, -1, 5, 10], 4);
  assert.equal(dropped, 2);
  assert.equal(buckets.reduce((a, b) => a + b, 0), 2);
});

test("logHistogram reports dropped: 0 when every sample is positive (the batch-timing case)", () => {
  const { dropped } = logHistogram([1, 2, 3, 4], 4);
  assert.equal(dropped, 0);
});
