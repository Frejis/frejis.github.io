// compress.js — Gorilla-style time-series compression. Pure, no DOM:
// importable from Node and the browser.
//
// This implements the scheme from Pelkonen et al., "Gorilla: A Fast,
// Scalable, In-Memory Time Series Database", VLDB 2015 (Facebook) — the
// algorithm Prometheus's chunk encoding and InfluxDB's TSM engine are both
// descended from. Two independent tricks, applied to a sorted sequence of
// (timestamp, value) samples:
//
//  1. Timestamps are stored as delta-of-delta (the second derivative of the
//     time axis). A regularly-sampled series has a CONSTANT delta, so its
//     delta-of-delta is zero every time after the first two points — the
//     paper's variable-length code spends exactly one bit per such sample.
//  2. Values are XORed against the previous value and the XOR is stored as
//     a leading-zero count, a meaningful-bit count, and the meaningful bits
//     themselves, reusing the previous block's window when it still fits.
//     A repeated or slowly-changing float (a network counter barely moves
//     between two one-second samples) XORs to all-zero or to a handful of
//     bits in the middle of the word.
//
// Everything here is exact and lossless — compressSeries/decompressSeries
// round-trip bit-for-bit, proved in compress.test.js.

// ============================================================================
// BitWriter / BitReader — MSB-first, sequential across byte boundaries.
// Built on BigInt so a value of any width up to 64 bits masks and shifts
// correctly; JS's native bitwise operators truncate to 32 bits, which is not
// enough for a raw millisecond timestamp (needs ~41 bits) or a float64's raw
// bit pattern (needs all 64).
// ============================================================================

export class BitWriter {
  constructor() {
    this.bytes = [];
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  /** Writes the low `width` bits of `value` (Number or BigInt), MSB first.
   * Negative values are written in their `width`-bit two's-complement form. */
  writeBits(value, width) {
    if (width === 0) return;
    const mask = (1n << BigInt(width)) - 1n;
    const v = BigInt(value) & mask;
    for (let i = width - 1; i >= 0; i--) {
      const bit = Number((v >> BigInt(i)) & 1n);
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

  /** Reads `width` bits, MSB first, as an unsigned BigInt. */
  readBits(width) {
    let value = 0n;
    for (let i = 0; i < width; i++) {
      const byte = this.bytes[this.byteIndex] ?? 0;
      const bit = (byte >>> (7 - this.bitIndex)) & 1;
      value = (value << 1n) | BigInt(bit);
      this.bitIndex++;
      if (this.bitIndex === 8) {
        this.bitIndex = 0;
        this.byteIndex++;
      }
    }
    return value;
  }
}

// Interprets an unsigned `width`-bit BigInt as a signed two's-complement
// Number. Safe for width <= 53 (every width used here is <= 32).
function signExtend(unsignedBig, width) {
  const half = 1n << BigInt(width - 1);
  const signed = unsignedBig >= half ? unsignedBig - (1n << BigInt(width)) : unsignedBig;
  return Number(signed);
}

// ============================================================================
// Timestamp compression: delta-of-delta, Gorilla's variable-length code.
// ============================================================================

// Bucket boundaries and bit widths as published in the paper (Section
// 4.1.1, Figure 3): a 1-bit escape ladder, widening the stored
// delta-of-delta as it falls further outside the previous bucket's range.
// The paper states the ranges as [-63, 64], [-255, 256], [-2047, 2048] -
// 128/512/4096 values each, one more positive value than a plain
// two's-complement field of that width can hold (7 bits two's complement is
// -64..63). Storing the value directly in two's complement (as this decoder
// does via signExtend) can therefore only cover -64..63, -256..255,
// -2048..2047 - the boundary this code actually uses; the discrepancy costs
// nothing but a beat's more escaping to the 32-bit tier at the single value
// (dod === 64, 256 or 2048) the paper's inclusive range would have covered.
const DOD_BUCKETS = [
  { min: -64, max: 63, prefix: 0b10, prefixBits: 2, width: 7 },
  { min: -256, max: 255, prefix: 0b110, prefixBits: 3, width: 9 },
  { min: -2048, max: 2047, prefix: 0b1110, prefixBits: 4, width: 12 },
];
const DOD_ESCAPE = { prefix: 0b1111, prefixBits: 4, width: 32 };

const TS_HEADER_BITS = 48; // raw first timestamp: comfortably covers ms-since-epoch
const TS_FIRST_DELTA_BITS = 32; // first interval, stored raw (unsigned)

/** Encodes a sorted array of integer timestamps (ms). Returns the count of
 * timestamps (from the 3rd onward) that cost exactly one bit — the headline
 * "regular sampling collapses to one bit" statistic. */
export function encodeTimestamps(bw, timestamps) {
  let oneBitCount = 0;
  if (timestamps.length === 0) return { oneBitCount };
  bw.writeBits(timestamps[0], TS_HEADER_BITS);
  if (timestamps.length === 1) return { oneBitCount };

  let prevDelta = timestamps[1] - timestamps[0];
  bw.writeBits(prevDelta, TS_FIRST_DELTA_BITS);
  let prevTs = timestamps[1];

  for (let i = 2; i < timestamps.length; i++) {
    const delta = timestamps[i] - prevTs;
    const dod = delta - prevDelta;
    if (dod === 0) {
      bw.writeBits(0, 1);
      oneBitCount++;
    } else {
      const bucket = DOD_BUCKETS.find((b) => dod >= b.min && dod <= b.max);
      if (bucket) {
        bw.writeBits(bucket.prefix, bucket.prefixBits);
        bw.writeBits(dod, bucket.width);
      } else {
        bw.writeBits(DOD_ESCAPE.prefix, DOD_ESCAPE.prefixBits);
        bw.writeBits(dod, DOD_ESCAPE.width);
      }
    }
    prevDelta = delta;
    prevTs = timestamps[i];
  }
  return { oneBitCount };
}

export function decodeTimestamps(br, count) {
  if (count === 0) return [];
  const t0 = Number(br.readBits(TS_HEADER_BITS));
  const out = [t0];
  if (count === 1) return out;

  let prevDelta = Number(br.readBits(TS_FIRST_DELTA_BITS));
  let prevTs = t0 + prevDelta;
  out.push(prevTs);

  for (let i = 2; i < count; i++) {
    let dod = 0;
    if (br.readBits(1) === 1n) {
      if (br.readBits(1) === 0n) {
        dod = signExtend(br.readBits(7), 7);
      } else if (br.readBits(1) === 0n) {
        dod = signExtend(br.readBits(9), 9);
      } else if (br.readBits(1) === 0n) {
        dod = signExtend(br.readBits(12), 12);
      } else {
        dod = signExtend(br.readBits(32), 32);
      }
    }
    const delta = prevDelta + dod;
    const ts = prevTs + delta;
    out.push(ts);
    prevDelta = delta;
    prevTs = ts;
  }
  return out;
}

// ============================================================================
// Value compression: XOR of consecutive float64 bit patterns.
// ============================================================================

function doubleToBits(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigUint64(0);
}

function bitsToDouble(bits) {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

// Straightforward bit-scan, not a De Bruijn trick: at series lengths this
// project deals with (thousands, not billions, of samples) clarity wins and
// the cost is invisible.
function clz64(bits) {
  if (bits === 0n) return 64;
  for (let i = 63; i >= 0; i--) {
    if ((bits >> BigInt(i)) & 1n) return 63 - i;
  }
  return 64;
}
function ctz64(bits) {
  if (bits === 0n) return 64;
  for (let i = 0; i <= 63; i++) {
    if ((bits >> BigInt(i)) & 1n) return i;
  }
  return 64;
}

const LEADING_BITS = 5; // stores 0..31: leading-zero counts above 31 are capped, see below
const LEN_BITS = 6; // stores (meaningfulLength - 1), 0..63, i.e. length 1..64

/** Encodes a sequence of float64 values by XOR against the previous value.
 * Returns the count of values (from the 2nd onward) whose XOR against their
 * predecessor was exactly zero — a full bit-for-bit repeat, one bit each. */
export function encodeValues(bw, values) {
  let zeroXorCount = 0;
  if (values.length === 0) return { zeroXorCount };

  let prevBits = doubleToBits(values[0]);
  bw.writeBits(prevBits, 64);
  let prevLeading = null;
  let prevTrailing = null;

  for (let i = 1; i < values.length; i++) {
    const bits = doubleToBits(values[i]);
    const xor = bits ^ prevBits;
    if (xor === 0n) {
      bw.writeBits(0, 1);
      zeroXorCount++;
    } else {
      const leading = clz64(xor);
      const trailing = ctz64(xor);
      if (prevLeading !== null && leading >= prevLeading && trailing >= prevTrailing) {
        // "10": the previous block's [leading, trailing) window still
        // covers this XOR's meaningful bits — reuse it, control cost 2 bits.
        bw.writeBits(0b10, 2);
        const meaningfulLen = 64 - prevLeading - prevTrailing;
        bw.writeBits(xor >> BigInt(prevTrailing), meaningfulLen);
      } else {
        // "11": a fresh window. Leading-zero count above 31 cannot fit the
        // paper's 5-bit field — cap it, which only widens the stored
        // meaningful-bit run and never loses information.
        const cappedLeading = Math.min(leading, (1 << LEADING_BITS) - 1);
        const meaningfulLen = 64 - cappedLeading - trailing;
        bw.writeBits(0b11, 2);
        bw.writeBits(cappedLeading, LEADING_BITS);
        bw.writeBits(meaningfulLen - 1, LEN_BITS);
        bw.writeBits(xor >> BigInt(trailing), meaningfulLen);
        prevLeading = cappedLeading;
        prevTrailing = trailing;
      }
    }
    prevBits = bits;
  }
  return { zeroXorCount };
}

export function decodeValues(br, count) {
  if (count === 0) return [];
  let prevBits = br.readBits(64);
  const out = [bitsToDouble(prevBits)];
  if (count === 1) return out;

  let prevLeading = null;
  let prevTrailing = null;

  for (let i = 1; i < count; i++) {
    let bits;
    if (br.readBits(1) === 0n) {
      bits = prevBits;
    } else if (br.readBits(1) === 0n) {
      const meaningfulLen = 64 - prevLeading - prevTrailing;
      const meaningful = br.readBits(meaningfulLen);
      bits = prevBits ^ (meaningful << BigInt(prevTrailing));
    } else {
      const leading = Number(br.readBits(LEADING_BITS));
      const meaningfulLen = Number(br.readBits(LEN_BITS)) + 1;
      const trailing = 64 - leading - meaningfulLen;
      const meaningful = br.readBits(meaningfulLen);
      bits = prevBits ^ (meaningful << BigInt(trailing));
      prevLeading = leading;
      prevTrailing = trailing;
    }
    out.push(bitsToDouble(bits));
    prevBits = bits;
  }
  return out;
}

// ============================================================================
// Whole-series compression: header (count) + timestamps + values, one
// continuous bitstream (no byte-alignment between sections, so no bits are
// spent padding a boundary that does not need one).
// ============================================================================

const COUNT_BITS = 32;

export function compressSeries(samples) {
  const bw = new BitWriter();
  bw.writeBits(samples.length, COUNT_BITS);
  const { oneBitCount } = encodeTimestamps(bw, samples.map((s) => s.ts));
  const { zeroXorCount } = encodeValues(bw, samples.map((s) => s.value));
  const bytes = bw.finish();
  return {
    bytes,
    count: samples.length,
    bitLength: bw.bitLength,
    oneBitTimestamps: oneBitCount,
    zeroXorValues: zeroXorCount,
  };
}

export function decompressSeries(bytes) {
  const br = new BitReader(bytes);
  const count = Number(br.readBits(COUNT_BITS));
  const timestamps = decodeTimestamps(br, count);
  const values = decodeValues(br, count);
  const samples = new Array(count);
  for (let i = 0; i < count; i++) samples[i] = { ts: timestamps[i], value: values[i] };
  return samples;
}

// Bytes a naive encoding would use: an 8-byte timestamp plus an 8-byte
// double per sample, the format a JSON array of {ts, value} objects
// approximates once you account for a fixed-width binary record instead of
// text. This is the baseline every compression-ratio figure on the page is
// measured against.
export const NAIVE_BYTES_PER_SAMPLE = 16;
