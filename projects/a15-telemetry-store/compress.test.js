import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BitWriter,
  BitReader,
  compressSeries,
  decompressSeries,
  encodeTimestamps,
  decodeTimestamps,
  encodeValues,
  decodeValues,
  NAIVE_BYTES_PER_SAMPLE,
} from "./compress.js";
import { generate } from "./stream.js";

// ---------------------------------------------------------------- BitWriter/Reader

test("BitWriter/BitReader round-trip at non-aligned widths", () => {
  const bw = new BitWriter();
  const widths = [1, 3, 7, 9, 12, 5, 32, 1, 17];
  const values = [1n, 5n, 100n, 300n, 4000n, 0n, 0xdeadbeefn, 0n, 90000n];
  for (let i = 0; i < widths.length; i++) bw.writeBits(values[i], widths[i]);
  const bytes = bw.finish();
  const br = new BitReader(bytes);
  for (let i = 0; i < widths.length; i++) {
    assert.equal(br.readBits(widths[i]), values[i], `field ${i} at width ${widths[i]}`);
  }
});

test("BitWriter.bitLength tracks bits written including a partial trailing byte", () => {
  const bw = new BitWriter();
  bw.writeBits(1, 1);
  assert.equal(bw.bitLength, 1);
  bw.writeBits(0, 7);
  assert.equal(bw.bitLength, 8);
  bw.writeBits(5, 3);
  assert.equal(bw.bitLength, 11);
});

// ---------------------------------------------------------------- Gorilla round-trip

function makeSeries(pattern) {
  return pattern.map(([ts, value]) => ({ ts, value }));
}

function roundTrip(samples) {
  const { bytes } = compressSeries(samples);
  return decompressSeries(bytes);
}

test("Gorilla round-trip is exact: regular series", () => {
  const samples = [];
  for (let i = 0; i < 200; i++) samples.push({ ts: 1000 + i * 1000, value: 100 + Math.sin(i / 5) });
  assert.deepEqual(roundTrip(samples), samples);
});

test("Gorilla round-trip is exact: irregular series", () => {
  const samples = [];
  let ts = 1000;
  for (let i = 0; i < 100; i++) {
    ts += 500 + (i % 7) * 137;
    samples.push({ ts, value: Math.cos(i) * 1000 });
  }
  assert.deepEqual(roundTrip(samples), samples);
});

test("Gorilla round-trip is exact: constant values", () => {
  const samples = makeSeries(Array.from({ length: 50 }, (_, i) => [1000 + i * 1000, 42.5]));
  assert.deepEqual(roundTrip(samples), samples);
});

test("Gorilla round-trip is exact: negatives, zero, and Float64 edge round-trips", () => {
  const samples = makeSeries([
    [0, 0],
    [1000, -1],
    [2000, -0.0001],
    [3000, 0],
    [4000, 123456789.123456],
    [5000, -123456789.123456],
    [6000, Number.MIN_VALUE],
    [7000, -Number.MAX_VALUE],
    [8000, 1e308],
    [9000, -1e308],
    [10000, 0.1 + 0.2], // classic float rounding value
  ]);
  const out = roundTrip(samples);
  assert.equal(out.length, samples.length);
  for (let i = 0; i < samples.length; i++) {
    assert.equal(Object.is(out[i].value, samples[i].value), true, `sample ${i}: ${out[i].value} !== ${samples[i].value}`);
    assert.equal(out[i].ts, samples[i].ts);
  }
});

test("Gorilla round-trip is exact: long random series", () => {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const samples = [];
  let ts = 0;
  let value = 0;
  for (let i = 0; i < 5000; i++) {
    ts += 1 + Math.floor(rand() * 20);
    value += (rand() - 0.5) * 10;
    samples.push({ ts, value });
  }
  assert.deepEqual(roundTrip(samples), samples);
});

test("Gorilla round-trip is exact: single-point series", () => {
  const samples = [{ ts: 5000, value: -3.5 }];
  assert.deepEqual(roundTrip(samples), samples);
});

test("Gorilla round-trip is exact: empty series", () => {
  assert.deepEqual(roundTrip([]), []);
});

// ---------------------------------------------------------------- the headline bit-cost claims

test("delta-of-delta spends exactly one bit per timestamp on a perfectly regular series", () => {
  const n = 300;
  const timestamps = Array.from({ length: n }, (_, i) => 1000 + i * 5000);
  const bw = new BitWriter();
  const { oneBitCount } = encodeTimestamps(bw, timestamps);

  // Every timestamp from the 3rd onward has dod === 0 on a perfectly regular
  // series, so it must cost exactly one bit each.
  assert.equal(oneBitCount, n - 2);

  // Arithmetic check against the actual encoded length: 48-bit header +
  // 32-bit first delta + (n - 2) one-bit dod codes.
  const expectedBits = 48 + 32 + (n - 2) * 1;
  assert.equal(bw.bitLength, expectedBits);

  const br = new BitReader(bw.finish());
  assert.deepEqual(decodeTimestamps(br, n), timestamps);
});

test("XOR value encoding spends one bit for a repeated value", () => {
  const values = [10, 10, 10, 10, 10];
  const bw = new BitWriter();
  const { zeroXorCount } = encodeValues(bw, values);
  assert.equal(zeroXorCount, 4); // every value after the first repeats exactly
  // 64-bit first value + 4 one-bit zero-XOR codes.
  assert.equal(bw.bitLength, 64 + 4);
  const br = new BitReader(bw.finish());
  assert.deepEqual(decodeValues(br, values.length), values);
});

test("XOR value encoding reuses the previous block's leading/trailing window when it still covers the current XOR", () => {
  // A crafted 3-value series where the reuse path (control code "10") must
  // fire on the third value: v1's XOR against v0 opens a fresh window with
  // leading=10, trailing=40 (a 14-bit meaningful run); v2's XOR against v1
  // has leading=18, trailing=41, which sits entirely inside [10, 40) and so
  // must reuse that window rather than open a fresh one. The 0.6 ratio
  // threshold in the test above does not bind tightly enough to catch this
  // optimisation being disabled outright — it only checks fleet-wide size,
  // and enough of that size is timestamps and zero-XOR repeats that losing
  // window reuse on the non-repeating values barely moves the ratio. This
  // checks the exact encoded bit count instead, the same style as the
  // delta-of-delta bit-count test above.
  const doubleFromBits = (bits) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(bits);
    return buf.readDoubleBE();
  };
  const v0bits = 0n;
  const xor1 = (1n << 53n) | (1n << 40n); // leading=10, trailing=40
  const v1bits = v0bits ^ xor1;
  const xor2 = (1n << 45n) | (1n << 41n); // leading=18, trailing=41: inside [10, 40)
  const v2bits = v1bits ^ xor2;
  const values = [0, doubleFromBits(v1bits), doubleFromBits(v2bits)];

  const bw = new BitWriter();
  encodeValues(bw, values);

  // 64-bit first value, then a fresh window for v1 (2 control + 5 leading +
  // 6 length + 14 meaningful bits = 27), then a reused window for v2 (2
  // control + 14 meaningful bits = 16, no leading/length fields at all).
  const expectedBits = 64 + (2 + 5 + 6 + 14) + (2 + 14);
  assert.equal(bw.bitLength, expectedBits, "reuse must cost only a 2-bit control code plus the meaningful bits");

  const br = new BitReader(bw.finish());
  const out = decodeValues(br, values.length);
  assert.ok(out.every((v, i) => Object.is(v, values[i])), "round-trip must still be exact through the reuse path");
});

test("compressed size is materially smaller than the naive 16-bytes-per-sample baseline on realistic data", () => {
  // Across the whole simulated topology, not just one series: some metrics
  // (crc_errors, mostly zero) compress far better than a noisy float like
  // light_dbm, and the point being tested is the fleet-wide saving, which is
  // what the headline number on the page is measured over too.
  const { samplesByKey } = generate({ seed: 7, nodeCount: 2, portsPerNode: 3, sampleCount: 1000, intervalMs: 10000 });
  let totalBytes = 0;
  let totalNaive = 0;
  for (const series of samplesByKey.values()) {
    for (const metric of Object.keys(series)) {
      const samples = series[metric];
      const { bytes } = compressSeries(samples);
      totalBytes += bytes.length;
      totalNaive += samples.length * NAIVE_BYTES_PER_SAMPLE;
    }
  }
  assert.ok(totalBytes < totalNaive * 0.6, `expected well under 60% of naive size, got ${totalBytes} vs ${totalNaive}`);
  // The single best-case metric (a monotonic counter with slowly-varying
  // rate) should compress far better still.
  const rx = samplesByKey.values().next().value.rx_bytes;
  const { bytes } = compressSeries(rx);
  const naiveBytes = rx.length * NAIVE_BYTES_PER_SAMPLE;
  assert.ok(bytes.length < naiveBytes * 0.6, `expected well under 60% of naive size for rx_bytes, got ${bytes.length} vs ${naiveBytes}`);
});
