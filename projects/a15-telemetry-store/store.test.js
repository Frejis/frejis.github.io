import { test } from "node:test";
import assert from "node:assert/strict";
import { TimeSeriesStore, matchLabels, seriesKey, downsample, rangeQuery, ratesWithResetHandling, naiveRates, detectAnomalies } from "./store.js";
import { generate, makeRng } from "./stream.js";

// ---------------------------------------------------------------- label matching

test("label matching selects exactly the right series: exact, wildcard, negative", () => {
  const store = new TimeSeriesStore();
  store.append("rx_bytes", { node: "aar-olt-01", port: "1/1/1" }, 0, 1);
  store.append("rx_bytes", { node: "aar-olt-01", port: "1/1/2" }, 0, 1);
  store.append("rx_bytes", { node: "aar-olt-02", port: "1/1/1" }, 0, 1);
  store.append("crc_errors", { node: "aar-olt-01", port: "1/1/1" }, 0, 0);

  const exact = store.query({ __name__: "rx_bytes", node: "aar-olt-01", port: "1/1/1" });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].labels.port, "1/1/1");

  const wildcard = store.query({ __name__: "rx_bytes", node: { op: "*", value: "olt-01" } });
  assert.equal(wildcard.length, 2);
  assert.ok(wildcard.every((s) => s.labels.node === "aar-olt-01"));

  const negative = store.query({ __name__: "rx_bytes", port: { op: "!=", value: "1/1/1" } });
  assert.equal(negative.length, 1);
  assert.equal(negative[0].labels.port, "1/1/2");

  assert.equal(store.query({ __name__: "crc_errors" }).length, 1);
});

test("seriesKey renders labels sorted and stable regardless of insertion order", () => {
  assert.equal(seriesKey("m", { b: "2", a: "1" }), seriesKey("m", { a: "1", b: "2" }));
});

// ---------------------------------------------------------------- downsampling

test("downsampled buckets have correct min/max/mean/last against a hand-computed example", () => {
  const samples = [
    { ts: 0, value: 10 },
    { ts: 1, value: 20 },
    { ts: 2, value: 5 },
    { ts: 10, value: 100 },
    { ts: 11, value: 200 },
  ];
  const buckets = downsample(samples, 0, 20, 2); // bucket 0: [0,10), bucket 1: [10,20)
  assert.equal(buckets.length, 2);
  assert.deepEqual([buckets[0].min, buckets[0].max], [5, 20]);
  assert.equal(buckets[0].mean, (10 + 20 + 5) / 3);
  assert.equal(buckets[0].last, 5); // ts=2 is the latest sample in this bucket
  assert.equal(buckets[0].count, 3);

  assert.deepEqual([buckets[1].min, buckets[1].max], [100, 200]);
  assert.equal(buckets[1].mean, 150);
  assert.equal(buckets[1].last, 200);
  assert.equal(buckets[1].count, 2);
});

test("rangeQuery returns raw points under the threshold and downsamples over it", () => {
  const samples = Array.from({ length: 10 }, (_, i) => ({ ts: i * 100, value: i }));
  const series = { samples };
  const raw = rangeQuery(series, 0, 1000, 400);
  assert.equal(raw.downsampled, false);
  assert.equal(raw.points.length, 10);

  const wide = rangeQuery(series, 0, 1000, 3);
  assert.equal(wide.downsampled, true);
  assert.equal(wide.points.length, 3);
});

// ---------------------------------------------------------------- counter reset

test("counter reset: naive rate produces a negative spike, the fix produces a correct non-negative rate", () => {
  const samples = [
    { ts: 0, value: 1000 },
    { ts: 1000, value: 2000 }, // +1000/s, normal
    { ts: 2000, value: 50 },   // device rebooted; counter restarted near zero
    { ts: 3000, value: 1050 }, // back to normal growth from the reset baseline
  ];

  const naive = naiveRates(samples);
  assert.equal(naive[0].rate, 1000);
  assert.ok(naive[1].rate < 0, "naive rate across a reset must be the negative-spike bug");
  assert.equal(naive[1].rate, (50 - 2000) / 1); // exactly the bug, spelled out

  const fixed = ratesWithResetHandling(samples);
  assert.equal(fixed[0].rate, 1000);
  assert.equal(fixed[0].reset, false);
  assert.ok(fixed[1].rate >= 0, "reset-aware rate must never go negative on a reset");
  assert.equal(fixed[1].reset, true);
  assert.equal(fixed[1].rate, 50); // post-reset value / dt, not the raw (negative) delta
  assert.equal(fixed[2].reset, false);
  assert.equal(fixed[2].rate, 1000);
});

// ---------------------------------------------------------------- anomaly detection

test("anomaly detector fires on an injected degradation and stays quiet on clean data", () => {
  const rng = makeRng(99);
  const clean = [];
  for (let i = 0; i < 60; i++) clean.push({ ts: i * 1000, value: -18 + rng.nextGaussian() * 0.3 });
  const { flags: cleanFlags } = detectAnomalies(clean);
  assert.equal(cleanFlags.some(Boolean), false, "clean, stable data must not be flagged");

  const degrading = clean.slice(0, 40).concat(
    Array.from({ length: 20 }, (_, i) => ({ ts: (40 + i) * 1000, value: -18 - i * 0.8 })) // steadily worsening light level
  );
  const { flags: degradingFlags } = detectAnomalies(degrading);
  assert.equal(degradingFlags.some(Boolean), true, "a steadily degrading signal must be flagged");
});

test("anomaly detector fires on a slow, sustained degradation once the onset has scrolled out of the window", () => {
  // A rolling window tracks a gradual ramp: each new point sits close to the
  // median of the points just before it, so a signal that drifts a fraction
  // of a dB per tick never looks locally anomalous, however far it has moved
  // from where it started. A detector that only ever sees the whole history
  // including the ramp's onset can still catch it as a LOCAL jump right at
  // the start of the ramp — but the live chart only ever shows a recent
  // window (see app.js's rangeQuery slice), and once you have advanced the
  // stream enough that the onset scrolls out of that window, only the
  // already-degraded, now-flat plateau remains — exactly the shape that
  // defeats a purely local rolling comparison. This reproduces that shape
  // directly (the -0.2dB/tick ramp and -30dBm floor match stream.js's
  // "degrade optical level" fault) rather than through the generator, so it
  // pins the detector's behaviour, not the generator's.
  const rng = makeRng(11);
  let light = -18;
  const onset = [];
  for (let i = 0; i < 60; i++) {
    light += rng.nextGaussian() * 0.05;
    onset.push({ ts: i * 30000, value: Math.round(light * 10) / 10 });
  }
  for (let i = 0; i < 400; i++) {
    light = Math.max(-30, light + rng.nextGaussian() * 0.05 - 0.2);
    onset.push({ ts: (60 + i) * 30000, value: Math.round(light * 10) / 10 });
  }
  assert.equal(onset[onset.length - 1].value, -30, "the ramp must reach the loss-of-signal floor and hold there");

  // The window a live chart would actually show after the onset has scrolled
  // out of it: the last 120 points, all at (or approaching) the floor.
  const windowed = onset.slice(-120);
  const { flags } = detectAnomalies(windowed, { window: 12, k: 5, minDeviation: 0.1, plausibleMin: -25 });
  assert.ok(flags.some(Boolean), "a sustained degradation to -30dBm must be flagged even once its onset is out of view");

  // Clean, stable data — the same shape of window, no fault — must still
  // not be flagged.
  const clean = onset.slice(0, 60);
  const { flags: cleanFlags } = detectAnomalies(clean, { window: 12, k: 5, minDeviation: 0.1, plausibleMin: -25 });
  assert.equal(cleanFlags.some(Boolean), false, "clean, stable data must not be flagged");
});

test("anomaly detector fires on a CRC error burst against a mostly-zero baseline", () => {
  const baseline = Array.from({ length: 30 }, (_, i) => ({ ts: i * 1000, value: 0 }));
  const burst = Array.from({ length: 5 }, (_, i) => ({ ts: (30 + i) * 1000, value: 40 }));
  const samples = baseline.concat(burst);
  const { flags } = detectAnomalies(samples, { minDeviation: 1 });
  assert.ok(flags.slice(30).some(Boolean), "the CRC burst must be flagged");
  assert.equal(flags.slice(0, 30).some(Boolean), false, "the flat baseline itself must not be flagged");
});

// ---------------------------------------------------------------- generator

test("the seeded generator is deterministic for a fixed seed", () => {
  const a = generate({ seed: 5, nodeCount: 2, portsPerNode: 2, sampleCount: 50 });
  const b = generate({ seed: 5, nodeCount: 2, portsPerNode: 2, sampleCount: 50 });
  const c = generate({ seed: 6, nodeCount: 2, portsPerNode: 2, sampleCount: 50 });

  for (const key of a.seriesKeys) {
    assert.deepEqual(a.samplesByKey.get(key), b.samplesByKey.get(key));
  }
  let anyDifferent = false;
  for (const key of a.seriesKeys) {
    if (JSON.stringify(a.samplesByKey.get(key)) !== JSON.stringify(c.samplesByKey.get(key))) anyDifferent = true;
  }
  assert.ok(anyDifferent, "a different seed must produce different data");
});

test("generated rx_bytes counters are monotonically increasing except across an injected reboot", () => {
  const { samplesByKey } = generate({
    seed: 3,
    nodeCount: 1,
    portsPerNode: 1,
    sampleCount: 40,
    faults: [{ atTick: 20, node: "aar-olt-01", port: "1/1/1", type: "reboot" }],
  });
  const rx = samplesByKey.get("aar-olt-01/1/1/1").rx_bytes;
  let resets = 0;
  for (let i = 1; i < rx.length; i++) {
    if (rx[i].value < rx[i - 1].value) resets++;
  }
  assert.equal(resets, 1, "exactly one reboot was injected, so exactly one reset should appear");
});
