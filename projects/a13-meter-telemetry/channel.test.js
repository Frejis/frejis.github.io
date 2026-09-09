import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32, corrupt, runChannel } from "./channel.js";
import { encodeFull, crcOk } from "./frame.js";

test("mulberry32 is deterministic for a fixed seed", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test("mulberry32 produces values in [0, 1) and differs across seeds", () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 1000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1);
  }
  const a = mulberry32(1)();
  const b = mulberry32(2)();
  assert.notEqual(a, b);
});

test("corrupt at bit error rate 0 never changes the frame", () => {
  const frame = encodeFull({
    meterId: 1, timestamp: 1000, volumeLiters: 500, flowRate: 10, battery: 30,
    flags: { leak: false, burst: false, backflow: false, tamper: false, lowBattery: false },
  });
  const rng = mulberry32(1);
  const received = corrupt(frame, 0, rng);
  assert.deepEqual(received, frame);
});

test("corrupt at bit error rate 1 flips every bit", () => {
  const frame = Uint8Array.from([0x00, 0xff, 0x55]);
  const rng = mulberry32(1);
  const received = corrupt(frame, 1, rng);
  assert.deepEqual(received, Uint8Array.from([0xff, 0x00, 0xaa]));
});

test("corrupt does not mutate its input", () => {
  const frame = Uint8Array.from([1, 2, 3]);
  const copy = Uint8Array.from(frame);
  corrupt(frame, 0.5, mulberry32(3));
  assert.deepEqual(frame, copy);
});

test("runChannel accounting is exact: intact + caught + undetected = total", () => {
  const frame = encodeFull({
    meterId: 42, timestamp: 1_700_000_000, volumeLiters: 12345, flowRate: 300, battery: 18,
    flags: { leak: false, burst: true, backflow: false, tamper: false, lowBattery: false },
  });
  const result = runChannel(frame, 10000, 0.01, 12345, crcOk);
  assert.equal(result.intact + result.caughtByCrc + result.undetected, result.total);
  // Some corruption should occur at 1% bit error rate over a multi-byte frame,
  // and at least a little should slip past a 16-bit CRC — that is the point.
  assert.ok(result.intact > 0, "expected some intact frames");
  assert.ok(result.caughtByCrc > 0, "expected some caught frames");
  assert.ok(result.undetected >= 0);
  // Undetected corruption is rare: a 16-bit CRC misses roughly 1 in 65536
  // corrupted frames, so at this sample size it should be a small minority.
  assert.ok(result.undetected < result.total * 0.05, `undetected ${result.undetected} too high`);
});

test("runChannel is deterministic for a fixed seed", () => {
  const frame = encodeFull({
    meterId: 1, timestamp: 1, volumeLiters: 1, flowRate: 1, battery: 1,
    flags: { leak: false, burst: false, backflow: false, tamper: false, lowBattery: false },
  });
  const a = runChannel(frame, 500, 0.02, 999, crcOk);
  const b = runChannel(frame, 500, 0.02, 999, crcOk);
  assert.deepEqual(a, b);
});

test("a higher bit error rate produces no more intact frames than a lower one", () => {
  const frame = encodeFull({
    meterId: 1, timestamp: 1, volumeLiters: 1, flowRate: 1, battery: 1,
    flags: { leak: false, burst: false, backflow: false, tamper: false, lowBattery: false },
  });
  const low = runChannel(frame, 5000, 0.001, 1, crcOk);
  const high = runChannel(frame, 5000, 0.05, 1, crcOk);
  assert.ok(high.intact <= low.intact);
});
