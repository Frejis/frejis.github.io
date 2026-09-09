// frame.js — the wire format. Pure, no DOM: importable from Node and the browser.
//
// A meter reading is packed into a compact byte array field by field, at bit
// widths chosen for the range each field actually needs, not the nearest byte
// boundary. That is the entire point of the project: a JSON object describing
// this reading would run to well over a hundred bytes; this format needs 12 to
// 15, because on a battery meant to survive well over a decade in the field
// every byte you do not send is milliamp-hours you keep.

// ============================================================================
// BitWriter / BitReader — MSB-first, sequential across byte boundaries.
// ============================================================================

export class BitWriter {
  constructor() {
    this.bytes = [];
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  /** Writes the low `width` bits of `value`, most-significant bit first. */
  writeBits(value, width) {
    for (let i = width - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      this.bitBuffer = (this.bitBuffer << 1) | bit;
      this.bitCount++;
      if (this.bitCount === 8) {
        this.bytes.push(this.bitBuffer & 0xff);
        this.bitBuffer = 0;
        this.bitCount = 0;
      }
    }
  }

  /** How many bits have been written so far, including a partial trailing byte. */
  get bitLength() {
    return this.bytes.length * 8 + this.bitCount;
  }

  /** Pads the last byte with zero bits and returns the whole buffer. */
  finish() {
    if (this.bitCount > 0) {
      this.bitBuffer = (this.bitBuffer << (8 - this.bitCount)) & 0xff;
      this.bytes.push(this.bitBuffer);
      this.bitBuffer = 0;
      this.bitCount = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

export class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.byteIndex = 0;
    this.bitIndex = 0;
  }

  /** Reads `width` bits, most-significant bit first, as an unsigned integer. */
  readBits(width) {
    let value = 0;
    for (let i = 0; i < width; i++) {
      const byte = this.bytes[this.byteIndex] ?? 0;
      const bit = (byte >>> (7 - this.bitIndex)) & 1;
      value = (value << 1) | bit;
      this.bitIndex++;
      if (this.bitIndex === 8) {
        this.bitIndex = 0;
        this.byteIndex++;
      }
    }
    return value >>> 0;
  }
}

// ============================================================================
// CRC-16/CCITT-FALSE. Poly 0x1021, init 0xFFFF, no reflection, no XOR-out.
//
// Chosen over the real wireless M-Bus CRC (CRC-16/EN13757, which reflects its
// input and output) because a bit-by-bit MSB-first division is something you
// can read straight off the register and believe; a reflected one hides the
// same arithmetic behind a bit-reversal step that adds nothing to a portfolio
// piece. It is a real, named CRC — not this project's real link-layer CRC.
//
// Test vector: CRC-16/CCITT-FALSE of the ASCII bytes "123456789" is 0x29B1.
// (The standard check value for this named CRC, from the CRC RevEng catalogue
// — crc16.test.js verifies it directly.)
// ============================================================================

const CRC_POLY = 0x1021;
const CRC_INIT = 0xffff;

export function crc16(bytes) {
  let crc = CRC_INIT;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ CRC_POLY) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

// ============================================================================
// Field layout.
// ============================================================================

export const FRAME_TYPE = { FULL: 0, DELTA: 1 };

export const FLAG_NAMES = ["leak", "burst", "backflow", "tamper", "lowBattery"];

export function packFlags(flags) {
  let v = 0;
  for (let i = 0; i < FLAG_NAMES.length; i++) {
    if (flags?.[FLAG_NAMES[i]]) v |= 1 << (FLAG_NAMES.length - 1 - i);
  }
  return v;
}

export function unpackFlags(v) {
  const out = {};
  for (let i = 0; i < FLAG_NAMES.length; i++) {
    out[FLAG_NAMES[i]] = ((v >>> (FLAG_NAMES.length - 1 - i)) & 1) === 1;
  }
  return out;
}

/** Bit widths for every field, in wire order. Assigns startBit/endBit for the UI. */
function withOffsets(fields) {
  let offset = 0;
  return fields.map((f) => {
    const startBit = offset;
    offset += f.bits;
    return { ...f, startBit, endBit: offset };
  });
}

export const FULL_FIELDS = withOffsets([
  { key: "frameType", label: "frame type", bits: 1 },
  { key: "meterId", label: "meter ID", bits: 24 },
  { key: "timestamp", label: "timestamp", bits: 32 },
  { key: "volumeLiters", label: "cumulative volume", bits: 24 },
  { key: "flowRate", label: "flow rate", bits: 11 },
  { key: "battery", label: "battery", bits: 5 },
  { key: "flags", label: "status flags", bits: 5 },
]);

export const DELTA_FIELDS = withOffsets([
  { key: "frameType", label: "frame type", bits: 1 },
  { key: "meterId", label: "meter ID", bits: 24 },
  { key: "timestampDelta", label: "\u0394 timestamp", bits: 16 },
  { key: "volumeDelta", label: "\u0394 volume", bits: 12 },
  { key: "flowRate", label: "flow rate", bits: 11 },
  { key: "battery", label: "battery", bits: 5 },
  { key: "flags", label: "status flags", bits: 5 },
]);

const totalBits = (fields) => fields.at(-1).endBit;
const payloadBytesFor = (fields) => Math.ceil(totalBits(fields) / 8);

export const FULL_PAYLOAD_BITS = totalBits(FULL_FIELDS);
export const DELTA_PAYLOAD_BITS = totalBits(DELTA_FIELDS);
export const FULL_PAYLOAD_BYTES = payloadBytesFor(FULL_FIELDS);
export const DELTA_PAYLOAD_BYTES = payloadBytesFor(DELTA_FIELDS);
export const CRC_BYTES = 2;
export const FULL_FRAME_BYTES = FULL_PAYLOAD_BYTES + CRC_BYTES;
export const DELTA_FRAME_BYTES = DELTA_PAYLOAD_BYTES + CRC_BYTES;

// The maximum value each field can hold at its bit width — the numbers the
// overflow test below hammers all at once.
export const FIELD_MAX = {
  meterId: 2 ** 24 - 1,
  timestamp: 2 ** 32 - 1,
  volumeLiters: 2 ** 24 - 1,
  timestampDelta: 2 ** 16 - 1,
  volumeDelta: 2 ** 12 - 1,
  flowRate: 2 ** 11 - 1,
  battery: 2 ** 5 - 1,
};

function requireRange(name, value, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be an integer in [0, ${max}], got ${value}`);
  }
}

// ============================================================================
// Full frames — every field, no history required.
// ============================================================================

export function encodeFull(reading) {
  requireRange("meterId", reading.meterId, FIELD_MAX.meterId);
  requireRange("timestamp", reading.timestamp, FIELD_MAX.timestamp);
  requireRange("volumeLiters", reading.volumeLiters, FIELD_MAX.volumeLiters);
  requireRange("flowRate", reading.flowRate, FIELD_MAX.flowRate);
  requireRange("battery", reading.battery, FIELD_MAX.battery);

  const w = new BitWriter();
  w.writeBits(FRAME_TYPE.FULL, 1);
  w.writeBits(reading.meterId, 24);
  w.writeBits(reading.timestamp, 32);
  w.writeBits(reading.volumeLiters, 24);
  w.writeBits(reading.flowRate, 11);
  w.writeBits(reading.battery, 5);
  w.writeBits(packFlags(reading.flags), 5);
  return appendCrc(w.finish());
}

export function decodeFull(bytes) {
  const { payload, crcValid } = splitCrc(bytes);
  const r = new BitReader(payload);
  const frameType = r.readBits(1);
  const reading = {
    meterId: r.readBits(24),
    timestamp: r.readBits(32),
    volumeLiters: r.readBits(24),
    flowRate: r.readBits(11),
    battery: r.readBits(5),
    flags: unpackFlags(r.readBits(5)),
  };
  return { frameType, crcValid, reading };
}

// ============================================================================
// Delta frames — a reading against the previous one. Smaller, at the cost of
// only covering intervals and volume increments that fit the delta widths
// (documented in the README, and enforced here rather than silently wrapping).
// ============================================================================

export function encodeDelta(reading, previous) {
  const timestampDelta = reading.timestamp - previous.timestamp;
  const volumeDelta = reading.volumeLiters - previous.volumeLiters;
  requireRange("meterId", reading.meterId, FIELD_MAX.meterId);
  requireRange("timestampDelta", timestampDelta, FIELD_MAX.timestampDelta);
  requireRange("volumeDelta", volumeDelta, FIELD_MAX.volumeDelta);
  requireRange("flowRate", reading.flowRate, FIELD_MAX.flowRate);
  requireRange("battery", reading.battery, FIELD_MAX.battery);

  const w = new BitWriter();
  w.writeBits(FRAME_TYPE.DELTA, 1);
  w.writeBits(reading.meterId, 24);
  w.writeBits(timestampDelta, 16);
  w.writeBits(volumeDelta, 12);
  w.writeBits(reading.flowRate, 11);
  w.writeBits(reading.battery, 5);
  w.writeBits(packFlags(reading.flags), 5);
  return appendCrc(w.finish());
}

/**
 * encodeDelta, but reporting an over-range jump as a value instead of an
 * uncaught throw — the demo's UI needs to render *something* honest for a
 * delta a real meter could not send either, rather than freezing on an
 * exception. `err` is the RangeError encodeDelta would have thrown, so the
 * caller still has the exact field name and bound to explain to the user.
 */
export function tryEncodeDelta(reading, previous) {
  try {
    return { ok: true, bytes: encodeDelta(reading, previous) };
  } catch (err) {
    if (err instanceof RangeError) return { ok: false, error: err };
    throw err;
  }
}

export function decodeDelta(bytes, previous) {
  const { payload, crcValid } = splitCrc(bytes);
  const r = new BitReader(payload);
  const frameType = r.readBits(1);
  const meterId = r.readBits(24);
  const timestampDelta = r.readBits(16);
  const volumeDelta = r.readBits(12);
  const flowRate = r.readBits(11);
  const battery = r.readBits(5);
  const flags = unpackFlags(r.readBits(5));
  const reading = {
    meterId,
    timestamp: previous.timestamp + timestampDelta,
    volumeLiters: previous.volumeLiters + volumeDelta,
    flowRate,
    battery,
    flags,
  };
  return { frameType, crcValid, reading, timestampDelta, volumeDelta };
}

// ============================================================================
// CRC framing shared by both frame kinds.
// ============================================================================

function appendCrc(payload) {
  const crc = crc16(payload);
  const out = new Uint8Array(payload.length + CRC_BYTES);
  out.set(payload);
  out[payload.length] = (crc >>> 8) & 0xff;
  out[payload.length + 1] = crc & 0xff;
  return out;
}

function splitCrc(bytes) {
  const payload = bytes.subarray(0, bytes.length - CRC_BYTES);
  const receivedCrc = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  return { payload, crcValid: crc16(payload) === receivedCrc };
}

/** Cheap CRC check alone, for the many-frame channel simulation. */
export function crcOk(bytes) {
  const payload = bytes.subarray(0, bytes.length - CRC_BYTES);
  const receivedCrc = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  return crc16(payload) === receivedCrc;
}

/** Decodes either frame kind, reading the 1-bit frame type first. */
export function decodeAny(bytes, previous) {
  const frameType = (bytes[0] >>> 7) & 1;
  return frameType === FRAME_TYPE.DELTA ? decodeDelta(bytes, previous) : decodeFull(bytes);
}

/**
 * Which field (or "pad"/"crc") owns a given bit of the whole frame, including
 * the CRC trailer — what the byte-map in the UI colours each bit by.
 */
export function fieldAtBit(fields, payloadBytes, bitIndex) {
  const payloadBits = payloadBytes * 8;
  if (bitIndex >= payloadBits + CRC_BYTES * 8) return null;
  if (bitIndex >= payloadBits) return "crc";
  for (const f of fields) {
    if (bitIndex >= f.startBit && bitIndex < f.endBit) return f.key;
  }
  return "pad";
}
