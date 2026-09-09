import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BitWriter,
  BitReader,
  crc16,
  encodeFull,
  decodeFull,
  encodeDelta,
  tryEncodeDelta,
  decodeDelta,
  decodeAny,
  crcOk,
  packFlags,
  unpackFlags,
  FLAG_NAMES,
  FIELD_MAX,
  FULL_FRAME_BYTES,
  DELTA_FRAME_BYTES,
  fieldAtBit,
  FULL_FIELDS,
} from "./frame.js";

// ---------------------------------------------------------------- BitWriter/BitReader

test("BitWriter/BitReader round-trip at non-byte-aligned widths", () => {
  const w = new BitWriter();
  w.writeBits(5, 3); // 101
  w.writeBits(1234, 11); // arbitrary 11-bit value
  w.writeBits(17, 5); // 5-bit value
  const bytes = w.finish();

  const r = new BitReader(bytes);
  assert.equal(r.readBits(3), 5);
  assert.equal(r.readBits(11), 1234);
  assert.equal(r.readBits(5), 17);
});

test("BitWriter/BitReader round-trip across many widths and many byte boundaries", () => {
  const widths = [1, 3, 7, 11, 2, 16, 5, 9, 4, 24, 1];
  const values = widths.map((w) => Math.floor(Math.random() * 2 ** w));
  const writer = new BitWriter();
  for (let i = 0; i < widths.length; i++) writer.writeBits(values[i], widths[i]);
  const reader = new BitReader(writer.finish());
  for (let i = 0; i < widths.length; i++) {
    assert.equal(reader.readBits(widths[i]), values[i], `field ${i} at width ${widths[i]}`);
  }
});

// ---------------------------------------------------------------- CRC-16/CCITT-FALSE

test("CRC-16/CCITT-FALSE matches the standard check value for \"123456789\"", () => {
  // The published check value for this named CRC (poly 0x1021, init 0xFFFF, no
  // reflection, no XOR-out) is 0x29B1 — see the CRC RevEng catalogue entry for
  // "CRC-16/CCITT-FALSE". frame.js implements exactly that arithmetic.
  const bytes = Uint8Array.from("123456789".split("").map((c) => c.charCodeAt(0)));
  assert.equal(crc16(bytes), 0x29b1);
});

test("CRC-16 of the empty input is the initial register value", () => {
  assert.equal(crc16(new Uint8Array(0)), 0xffff);
});

// ---------------------------------------------------------------- flags

test("flags pack and unpack every combination exactly", () => {
  for (let mask = 0; mask < 32; mask++) {
    const flags = {};
    FLAG_NAMES.forEach((name, i) => { flags[name] = ((mask >>> (FLAG_NAMES.length - 1 - i)) & 1) === 1; });
    const packed = packFlags(flags);
    assert.deepEqual(unpackFlags(packed), flags);
  }
});

// ---------------------------------------------------------------- full frame round-trip

const BASE_READING = {
  meterId: 123456,
  timestamp: 1_700_000_000,
  volumeLiters: 987654,
  flowRate: 512,
  battery: 20,
  flags: { leak: false, burst: false, backflow: true, tamper: false, lowBattery: false },
};

test("full frame encode/decode round-trips every field exactly", () => {
  const frame = encodeFull(BASE_READING);
  assert.equal(frame.length, FULL_FRAME_BYTES);
  const { reading, crcValid } = decodeFull(frame);
  assert.ok(crcValid);
  assert.deepEqual(reading, BASE_READING);
});

test("full frame round-trips minimum values for every field", () => {
  const reading = {
    meterId: 0, timestamp: 0, volumeLiters: 0, flowRate: 0, battery: 0,
    flags: { leak: false, burst: false, backflow: false, tamper: false, lowBattery: false },
  };
  const { reading: got, crcValid } = decodeFull(encodeFull(reading));
  assert.ok(crcValid);
  assert.deepEqual(got, reading);
});

test("full frame round-trips maximum values and all flags set", () => {
  const reading = {
    meterId: FIELD_MAX.meterId,
    timestamp: FIELD_MAX.timestamp,
    volumeLiters: FIELD_MAX.volumeLiters,
    flowRate: FIELD_MAX.flowRate,
    battery: FIELD_MAX.battery,
    flags: { leak: true, burst: true, backflow: true, tamper: true, lowBattery: true },
  };
  const { reading: got, crcValid } = decodeFull(encodeFull(reading));
  assert.ok(crcValid);
  assert.deepEqual(got, reading);
});

test("a field at its maximum does not overflow into its neighbour", () => {
  // The classic bit-packing bug: write every field at its maximum value at
  // once and confirm each decodes to exactly its own maximum, not spilling
  // one bit into whatever comes next in the layout.
  const reading = {
    meterId: FIELD_MAX.meterId,
    timestamp: FIELD_MAX.timestamp,
    volumeLiters: FIELD_MAX.volumeLiters,
    flowRate: FIELD_MAX.flowRate,
    battery: FIELD_MAX.battery,
    flags: { leak: true, burst: true, backflow: true, tamper: true, lowBattery: true },
  };
  const { reading: got } = decodeFull(encodeFull(reading));
  assert.equal(got.meterId, FIELD_MAX.meterId);
  assert.equal(got.timestamp, FIELD_MAX.timestamp);
  assert.equal(got.volumeLiters, FIELD_MAX.volumeLiters);
  assert.equal(got.flowRate, FIELD_MAX.flowRate);
  assert.equal(got.battery, FIELD_MAX.battery);

  // And a frame with every OTHER field at zero except one at its maximum must
  // leave every other field at exactly zero — no bleed either direction.
  const isolated = {
    meterId: 0, timestamp: 0, volumeLiters: 0, flowRate: FIELD_MAX.flowRate, battery: 0,
    flags: { leak: false, burst: false, backflow: false, tamper: false, lowBattery: false },
  };
  const { reading: gotIsolated } = decodeFull(encodeFull(isolated));
  assert.equal(gotIsolated.meterId, 0);
  assert.equal(gotIsolated.timestamp, 0);
  assert.equal(gotIsolated.volumeLiters, 0);
  assert.equal(gotIsolated.battery, 0);
  assert.equal(gotIsolated.flowRate, FIELD_MAX.flowRate);
});

test("out-of-range field values are rejected rather than silently truncated", () => {
  assert.throws(() => encodeFull({ ...BASE_READING, flowRate: FIELD_MAX.flowRate + 1 }), RangeError);
  assert.throws(() => encodeFull({ ...BASE_READING, battery: -1 }), RangeError);
});

// ---------------------------------------------------------------- delta frame

test("delta frame is strictly smaller than full for a typical consecutive reading and round-trips", () => {
  const previous = BASE_READING;
  const next = {
    ...BASE_READING,
    timestamp: previous.timestamp + 900, // 15 minutes later
    volumeLiters: previous.volumeLiters + 12,
    flowRate: 480,
  };
  const full = encodeFull(next);
  const delta = encodeDelta(next, previous);
  assert.ok(delta.length < full.length, `delta ${delta.length} bytes, full ${full.length} bytes`);

  const { reading, crcValid } = decodeDelta(delta, previous);
  assert.ok(crcValid);
  assert.deepEqual(reading, next);
});

test("delta frame round-trips at its own min and max deltas", () => {
  const previous = BASE_READING;
  const zeroDelta = { ...BASE_READING, timestamp: previous.timestamp, volumeLiters: previous.volumeLiters };
  const { reading: gotZero, crcValid: zeroValid } = decodeDelta(encodeDelta(zeroDelta, previous), previous);
  assert.ok(zeroValid);
  assert.deepEqual(gotZero, zeroDelta);

  const maxDelta = {
    ...BASE_READING,
    timestamp: previous.timestamp + FIELD_MAX.timestampDelta,
    volumeLiters: previous.volumeLiters + FIELD_MAX.volumeDelta,
  };
  const { reading: gotMax, crcValid: maxValid } = decodeDelta(encodeDelta(maxDelta, previous), previous);
  assert.ok(maxValid);
  assert.deepEqual(gotMax, maxDelta);
});

test("delta frame rejects a jump too large for the delta field width", () => {
  const previous = BASE_READING;
  const tooFar = { ...BASE_READING, timestamp: previous.timestamp + FIELD_MAX.timestampDelta + 1 };
  assert.throws(() => encodeDelta(tooFar, previous), RangeError);
});

test("a volume jump beyond the 12-bit delta field's capacity is rejected, not silently wrapped", () => {
  // The bug this guards against: index.html's cumulative-volume slider goes
  // up to 2,000,000, far past what a 12-bit delta (max 4095) can encode
  // against a fixed previous reading — encodeDelta must fail loudly here,
  // not wrap the value or bleed it into flowRate.
  const previous = BASE_READING;
  const justOver = { ...BASE_READING, volumeLiters: previous.volumeLiters + FIELD_MAX.volumeDelta + 1 };
  assert.throws(() => encodeDelta(justOver, previous), RangeError);

  const wayOver = { ...BASE_READING, volumeLiters: previous.volumeLiters + 1_000_000 };
  assert.throws(() => encodeDelta(wayOver, previous), RangeError);
});

test("tryEncodeDelta reports an over-range jump as a value instead of throwing", () => {
  const previous = BASE_READING;
  const wayOver = { ...BASE_READING, volumeLiters: previous.volumeLiters + 1_000_000 };

  const failed = tryEncodeDelta(wayOver, previous);
  assert.equal(failed.ok, false);
  assert.ok(failed.error instanceof RangeError);
  assert.match(failed.error.message, /volumeDelta/);

  // And recovery: a reading back within range still encodes normally, the
  // same guarantee the UI relies on when the slider is dragged back.
  const inRange = { ...BASE_READING, volumeLiters: previous.volumeLiters + 40 };
  const recovered = tryEncodeDelta(inRange, previous);
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.bytes, encodeDelta(inRange, previous));
});

test("decodeAny dispatches on the frame-type bit to the right decoder", () => {
  const full = encodeFull(BASE_READING);
  const next = { ...BASE_READING, timestamp: BASE_READING.timestamp + 60 };
  const delta = encodeDelta(next, BASE_READING);
  assert.deepEqual(decodeAny(full).reading, BASE_READING);
  assert.deepEqual(decodeAny(delta, BASE_READING).reading, next);
});

// ---------------------------------------------------------------- corruption / CRC

test("flipping any single bit in a frame is caught by the CRC", () => {
  const frame = encodeFull(BASE_READING);
  for (let byteIndex = 0; byteIndex < frame.length; byteIndex++) {
    for (let bit = 0; bit < 8; bit++) {
      const corrupted = Uint8Array.from(frame);
      corrupted[byteIndex] ^= 1 << bit;
      assert.equal(
        crcOk(corrupted),
        false,
        `bit ${bit} of byte ${byteIndex} was not caught`
      );
    }
  }
});

test("an untouched frame passes its own CRC", () => {
  assert.ok(crcOk(encodeFull(BASE_READING)));
  assert.ok(crcOk(encodeDelta({ ...BASE_READING, timestamp: BASE_READING.timestamp + 1 }, BASE_READING)));
});

// ---------------------------------------------------------------- byte-map helper

test("fieldAtBit assigns every payload bit to exactly one field, and the trailer to the CRC", () => {
  const payloadBytes = FULL_FRAME_BYTES - 2;
  const seen = new Set();
  for (let bit = 0; bit < payloadBytes * 8; bit++) {
    const owner = fieldAtBit(FULL_FIELDS, payloadBytes, bit);
    assert.ok(owner && owner !== "crc", `bit ${bit} unowned`);
    seen.add(owner);
  }
  for (const f of FULL_FIELDS) assert.ok(seen.has(f.key), `field ${f.key} never appears in the map`);
  for (let bit = payloadBytes * 8; bit < FULL_FRAME_BYTES * 8; bit++) {
    assert.equal(fieldAtBit(FULL_FIELDS, payloadBytes, bit), "crc");
  }
});
