// attacks.js — every attack on this page, implemented for real, with no DOM.
// Importable from Node (see attacks.test.js) and from the browser (app.js).
//
// Nothing here is a simulation: the block cipher is a real AES-128, the padding
// oracle attack really does recover plaintext one byte at a time from a single
// bit of leaked information, and the length extension really does forge a MAC
// that the naive verifier accepts. The tests are the proof.

// ============================================================================
// GF(2^8) and the AES S-box, derived rather than pasted in as a magic table.
// ============================================================================

const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);

const xtime = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;

(function buildTables() {
  // 3 is a generator of the multiplicative group; 3*x == x ^ xtime(x).
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x ^ xtime(x)) & 0xff;
  }
  EXP[255] = EXP[0];

  for (let i = 0; i < 256; i++) {
    const inv = i === 0 ? 0 : EXP[255 - LOG[i]];
    let s = inv;
    for (let r = 0; r < 4; r++) s ^= ((inv << (r + 1)) | (inv >>> (7 - r))) & 0xff;
    SBOX[i] = s ^ 0x63;
  }
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
})();

function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % 255];
}

// ============================================================================
// AES-128. Single block, both directions. FIPS-197, no shortcuts.
// ============================================================================

const ROUNDS = 10;
const BLOCK = 16;

/** Expands a 16-byte key into 11 round keys (176 bytes). */
export function expandKey(key) {
  if (key.length !== 16) throw new Error("AES-128 needs a 16-byte key");
  const w = new Uint8Array(16 * (ROUNDS + 1));
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < w.length; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 16 === 0) {
      // rotate, substitute, then fold in the round constant
      [t0, t1, t2, t3] = [SBOX[t1] ^ rcon, SBOX[t2], SBOX[t3], SBOX[t0]];
      rcon = xtime(rcon);
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

const addRoundKey = (s, w, round) => {
  for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
};

// State is column-major: byte i sits at row i%4, column i/4.
const shiftRows = (s) => {
  let t;
  t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
  t = s[2]; s[2] = s[10]; s[10] = t;
  t = s[6]; s[6] = s[14]; s[14] = t;
  t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
};

const invShiftRows = (s) => {
  let t;
  t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
  t = s[2]; s[2] = s[10]; s[10] = t;
  t = s[6]; s[6] = s[14]; s[14] = t;
  t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
};

function mixColumns(s) {
  for (let c = 0; c < 16; c += 4) {
    const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
    s[c] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3;
    s[c + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3;
    s[c + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3);
    s[c + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2);
  }
}

function invMixColumns(s) {
  for (let c = 0; c < 16; c += 4) {
    const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
    s[c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
    s[c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
    s[c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
    s[c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
  }
}

/** Encrypts exactly one 16-byte block. `w` comes from expandKey. */
export function encryptBlock(w, input) {
  const s = Uint8Array.from(input);
  addRoundKey(s, w, 0);
  for (let r = 1; r < ROUNDS; r++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    shiftRows(s);
    mixColumns(s);
    addRoundKey(s, w, r);
  }
  for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
  shiftRows(s);
  addRoundKey(s, w, ROUNDS);
  return s;
}

/** Decrypts exactly one 16-byte block. */
export function decryptBlock(w, input) {
  const s = Uint8Array.from(input);
  addRoundKey(s, w, ROUNDS);
  for (let r = ROUNDS - 1; r >= 1; r--) {
    invShiftRows(s);
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    addRoundKey(s, w, r);
    invMixColumns(s);
  }
  invShiftRows(s);
  for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
  addRoundKey(s, w, 0);
  return s;
}

// ============================================================================
// Modes of operation. ECB is here to be broken; CBC and CTR are the contrast.
// ============================================================================

export function ecbEncrypt(key, data) {
  const w = expandKey(key);
  const out = new Uint8Array(data.length - (data.length % BLOCK));
  for (let i = 0; i + BLOCK <= data.length; i += BLOCK) {
    out.set(encryptBlock(w, data.subarray(i, i + BLOCK)), i);
  }
  return out;
}

export function ecbDecrypt(key, data) {
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  for (let i = 0; i + BLOCK <= data.length; i += BLOCK) {
    out.set(decryptBlock(w, data.subarray(i, i + BLOCK)), i);
  }
  return out;
}

/** Raw CBC over a whole number of blocks. Padding is the caller's business. */
export function cbcEncryptRaw(key, iv, data) {
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev = Uint8Array.from(iv);
  for (let i = 0; i + BLOCK <= data.length; i += BLOCK) {
    const block = new Uint8Array(BLOCK);
    for (let j = 0; j < BLOCK; j++) block[j] = data[i + j] ^ prev[j];
    prev = encryptBlock(w, block);
    out.set(prev, i);
  }
  return out;
}

export function cbcDecryptRaw(key, iv, data) {
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev = Uint8Array.from(iv);
  for (let i = 0; i + BLOCK <= data.length; i += BLOCK) {
    const ct = data.subarray(i, i + BLOCK);
    const dec = decryptBlock(w, ct);
    for (let j = 0; j < BLOCK; j++) out[i + j] = dec[j] ^ prev[j];
    prev = Uint8Array.from(ct);
  }
  return out;
}

/** AES-CTR. Also serves as the stream cipher in the nonce-reuse demo. */
export function ctrKeystream(key, nonce, length) {
  const w = expandKey(key);
  const out = new Uint8Array(length);
  const counter = new Uint8Array(BLOCK);
  counter.set(nonce.subarray(0, Math.min(nonce.length, 8)));
  for (let i = 0, c = 0; i < length; i += BLOCK, c++) {
    // 32-bit big-endian counter in the last four bytes
    counter[12] = (c >>> 24) & 0xff;
    counter[13] = (c >>> 16) & 0xff;
    counter[14] = (c >>> 8) & 0xff;
    counter[15] = c & 0xff;
    out.set(encryptBlock(w, counter).subarray(0, Math.min(BLOCK, length - i)), i);
  }
  return out;
}

export function ctrEncrypt(key, nonce, data) {
  return xorBytes(data, ctrKeystream(key, nonce, data.length));
}

export function xorBytes(a, b) {
  const n = Math.min(a.length, b.length);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] ^ b[i];
  return out;
}

// ============================================================================
// PKCS#7 padding — the thing the oracle leaks.
// ============================================================================

export function pkcs7Pad(data, blockSize = BLOCK) {
  const padLen = blockSize - (data.length % blockSize);
  const out = new Uint8Array(data.length + padLen);
  out.set(data);
  out.fill(padLen, data.length);
  return out;
}

/** Returns the unpadded data, or null when the padding is malformed. */
export function pkcs7Unpad(data, blockSize = BLOCK) {
  if (data.length === 0 || data.length % blockSize !== 0) return null;
  const padLen = data[data.length - 1];
  if (padLen < 1 || padLen > blockSize || padLen > data.length) return null;
  for (let i = data.length - padLen; i < data.length; i++) {
    if (data[i] !== padLen) return null;
  }
  return data.subarray(0, data.length - padLen);
}

// ============================================================================
// Attack 3: the padding oracle.
// ============================================================================

/**
 * A server that decrypts CBC and answers exactly one question: was the padding
 * well formed. That single bit is enough to decrypt everything it ever sends.
 */
export class PaddingOracle {
  constructor(key) {
    this.key = Uint8Array.from(key);
    this.queries = 0;
  }

  /** Encrypts a message the way the vulnerable server would: CBC, no MAC. */
  seal(iv, plaintext) {
    return cbcEncryptRaw(this.key, iv, pkcs7Pad(plaintext));
  }

  /** The leak. True iff the padding of the decryption is valid. */
  isPaddingValid(iv, ciphertext) {
    this.queries++;
    return pkcs7Unpad(cbcDecryptRaw(this.key, iv, ciphertext)) !== null;
  }
}

/**
 * Byte-by-byte CBC padding oracle attack.
 *
 * For each ciphertext block C[i], we forge a two-block message (C', C[i]) where
 * C' is under our control. The server computes P' = D(C[i]) XOR C', so by
 * hunting for the C' byte that makes the padding valid we learn D(C[i]) one
 * byte at a time, right to left — and the real plaintext is D(C[i]) XOR C[i-1].
 *
 * `onStep({ blockIndex, byteIndex, guess, valid, recovered, queries })` is
 * called for every oracle query, which is what the animation in app.js draws.
 */
export function paddingOracleAttack(oracle, iv, ciphertext, onStep) {
  const blocks = [];
  for (let i = 0; i < ciphertext.length; i += BLOCK) {
    blocks.push(ciphertext.subarray(i, i + BLOCK));
  }
  const prevBlocks = [Uint8Array.from(iv), ...blocks.slice(0, -1)];
  const recovered = new Uint8Array(ciphertext.length);

  for (let b = 0; b < blocks.length; b++) {
    const target = blocks[b];
    const inter = new Uint8Array(BLOCK); // D(target), the raw block decryption
    for (let pos = BLOCK - 1; pos >= 0; pos--) {
      const padValue = BLOCK - pos;
      const forged = new Uint8Array(BLOCK);
      for (let j = pos + 1; j < BLOCK; j++) forged[j] = inter[j] ^ padValue;

      let found = -1;
      for (let g = 0; g < 256; g++) {
        forged[pos] = g;
        let valid = oracle.isPaddingValid(forged, target);
        // Guard against the false positive at pos 14: a valid 0x01 could
        // really be 0x02 0x02. Perturb the byte to the left and re-ask.
        if (valid && pos === BLOCK - 1) {
          const probe = Uint8Array.from(forged);
          probe[pos - 1] ^= 0xff;
          valid = oracle.isPaddingValid(probe, target);
        }
        if (onStep) {
          onStep({
            blockIndex: b,
            byteIndex: pos,
            guess: g,
            valid,
            queries: oracle.queries,
          });
        }
        if (valid) {
          found = g;
          break;
        }
      }
      if (found < 0) throw new Error(`no valid padding byte found at block ${b} byte ${pos}`);
      inter[pos] = found ^ padValue;
      recovered[b * BLOCK + pos] = inter[pos] ^ prevBlocks[b][pos];
    }
  }

  const unpadded = pkcs7Unpad(recovered);
  return { padded: recovered, plaintext: unpadded ? Uint8Array.from(unpadded) : recovered };
}

// ============================================================================
// Attack 2: two-time pad. One keystream, two messages.
// ============================================================================

// A short English sample, used only to build a character bigram model at load.
// Training the scorer from text rather than pasting a frequency table keeps the
// statistics honest and lets you see exactly what the attack "knows".
const TRAINING_TEXT = `
the quick brown fox jumps over the lazy dog. it is a truth universally
acknowledged that a single man in possession of a good fortune must be in want
of a wife. we hold these truths to be self evident, that all men are created
equal, that they are endowed by their creator with certain unalienable rights.
call me ishmael. some years ago, never mind how long precisely, having little
or no money in my purse, and nothing particular to interest me on shore, i
thought i would sail about a little and see the watery part of the world.
it was the best of times, it was the worst of times, it was the age of wisdom,
it was the age of foolishness, it was the epoch of belief, it was the epoch of
incredulity, it was the season of light, it was the season of darkness.
all happy families are alike; each unhappy family is unhappy in its own way.
in a hole in the ground there lived a hobbit. not a nasty, dirty, wet hole,
filled with the ends of worms and an oozy smell, nor yet a dry, bare, sandy
hole with nothing in it to sit down on or to eat: it was a hobbit hole, and
that means comfort. the sky above the port was the colour of television,
tuned to a dead channel. many years later, as he faced the firing squad,
colonel aureliano buendia was to remember that distant afternoon when his
father took him to discover ice. we were somewhere around barstow on the edge
of the desert when the drugs began to take hold. the past is a foreign
country: they do things differently there. it is a period of civil war, and
the message was sent at dawn and the answer came back before noon.
please meet me at the station tomorrow and bring the documents with you.
the report says the system is secure but nobody has actually checked it.
`;

const ALPHA = 28; // a-z, space, everything else
const classOf = (byte) => {
  if (byte === 32) return 26;
  const c = byte | 0x20; // fold case
  if (c >= 97 && c <= 122) return c - 97;
  return 27;
};

// A character trigram model, interpolated with a bigram model so unseen
// contexts fall back gracefully instead of vetoing a correct key byte. Two
// characters of context is what carries the beam search through the long
// stretches where the bigram model alone drifts.
const { BIGRAM, TRIGRAM } = (() => {
  const bi = new Float64Array(ALPHA * ALPHA).fill(0.1); // add-k smoothing
  const tri = new Float64Array(ALPHA * ALPHA * ALPHA).fill(0.05);
  const bytes = new TextEncoder().encode(TRAINING_TEXT.replace(/\s+/g, " "));
  for (let i = 1; i < bytes.length; i++) {
    const a = classOf(bytes[i - 1]);
    const b = classOf(bytes[i]);
    bi[a * ALPHA + b] += 1;
    if (i >= 2) tri[(classOf(bytes[i - 2]) * ALPHA + a) * ALPHA + b] += 1;
  }
  const biLog = new Float64Array(ALPHA * ALPHA);
  for (let a = 0; a < ALPHA; a++) {
    let total = 0;
    for (let b = 0; b < ALPHA; b++) total += bi[a * ALPHA + b];
    for (let b = 0; b < ALPHA; b++) biLog[a * ALPHA + b] = Math.log(bi[a * ALPHA + b] / total);
  }
  const triLog = new Float64Array(tri.length);
  for (let ctx = 0; ctx < ALPHA * ALPHA; ctx++) {
    let total = 0;
    for (let b = 0; b < ALPHA; b++) total += tri[ctx * ALPHA + b];
    for (let b = 0; b < ALPHA; b++) {
      // 0.7 trigram / 0.3 bigram interpolation
      const p = 0.7 * (tri[ctx * ALPHA + b] / total) + 0.3 * Math.exp(biLog[(ctx % ALPHA) * ALPHA + b]);
      triLog[ctx * ALPHA + b] = Math.log(p);
    }
  }
  return { BIGRAM: biLog, TRIGRAM: triLog };
})();

// Bytes that never appear in the messages we care about are worth ruling out
// hard: one impossible character kills a candidate key byte outright.
function bytePenalty(byte) {
  if (byte === 32 || byte === 10) return 0;
  if (byte >= 97 && byte <= 122) return 0;
  if (byte >= 65 && byte <= 90) return -0.6;
  if (byte >= 48 && byte <= 57) return -2.5;
  if (byte === 46 || byte === 44 || byte === 39 || byte === 33 || byte === 63 ||
      byte === 58 || byte === 59 || byte === 45) return -2.5;
  return -18;
}

// A character model alone is not enough. It happily prefers a fluent-looking
// splice of the two messages ("not tell ast at these me are iscol") to the
// truth, because every trigram in the splice is common even though no word is
// real. Words are the constraint that character statistics miss, so the scorer
// also asks whether what it is reading is made of actual English.
const DICT = new Set(`a about after all also an and any are as at back be because been
before being between both but by call came can come could day did do does down each
even every first for from get give go going good got had has have he her here him his
how i if in into is it its just know last left let like little long look made make
man many may me men might money more morning most move much must my never new next
night no not now of off old on once one only or other our out over own part people
place put right said same say see she should show since so some still such take tell
than that the their them then there these they thing think this those though thought
three through time to today told too took two under up us use very want was way we
well went were what when where which while who why will with within without word work
world would year years yes yet you your account admin after amount attack authority
bank bridge bring cash check code contact courier data dawn deliver delivery
documents evening everyone file files friday gate get harbour hold house key keys
list meet meeting message midnight morning move north nine noon number office
package papers password plan planned please point port receive report ridge safe
send sent server shipment ship south station system team tomorrow tonight train
transfer wait watch west window you`.split(/\s+/).filter(Boolean));

/**
 * Rewards real words and punishes long stretches of letters that are not
 * words. This is what stops the search splicing the two plaintexts together:
 * a splice breaks words at the junction even when it keeps the trigrams happy.
 */
export function wordBonus(bytes, { partialStart = false, partialEnd = true } = {}) {
  let score = 0;
  let word = "";
  let wordStart = 0;
  const flush = (endIndex) => {
    if (word.length === 0) return;
    // A letter run touching either end of the buffer may be a fragment of a
    // longer word rather than a word in its own right - the message simply
    // stops there. Reward it if it is a word, but never charge for it, or the
    // scorer punishes correct plaintext for being cut off and happily replaces
    // the last few characters with noise. This was visibly mangling the tail
    // of every recovered message.
    const partial =
      (partialStart && wordStart === 0) || (partialEnd && endIndex === bytes.length);
    if (DICT.has(word)) score += 4.0 * word.length;
    else if (word.length >= 3 && !partial) score -= 3.0 * word.length;
    word = "";
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 97 && b <= 122) {
      if (word.length === 0) wordStart = i;
      word += String.fromCharCode(b);
    } else if (b >= 65 && b <= 90) {
      if (word.length === 0) wordStart = i;
      word += String.fromCharCode(b + 32);
    } else {
      flush(i);
    }
  }
  flush(bytes.length);
  return score;
}

/**
 * The exact objective the beam search maximises, evaluated on a whole
 * candidate keystream. Exported so the quality of a search result can be
 * separated from the quality of the model: if the true keystream scores lower
 * than what the search found, no amount of extra search width will help.
 */
export function objectiveScore(ct1, ct2, keystream) {
  const SP = classOf(32);
  let s = 0;
  let a1 = SP, b1 = SP, a2 = SP, b2 = SP;
  for (let i = 0; i < keystream.length; i++) {
    const p1 = ct1[i] ^ keystream[i];
    const p2 = ct2[i] ^ keystream[i];
    const c1 = classOf(p1);
    const c2 = classOf(p2);
    s += bytePenalty(p1) + bytePenalty(p2);
    s += TRIGRAM[(a1 * ALPHA + b1) * ALPHA + c1] + TRIGRAM[(a2 * ALPHA + b2) * ALPHA + c2];
    a1 = b1; b1 = c1;
    a2 = b2; b2 = c2;
  }
  return s + wordBonus(xorBytes(ct1, keystream)) + wordBonus(xorBytes(ct2, keystream));
}

/** Log-likelihood that a byte string is English. Higher is better. */
export function englishScore(bytes) {
  let s = 0;
  for (let i = 0; i < bytes.length; i++) {
    s += bytePenalty(bytes[i]);
    if (i > 0) s += BIGRAM[classOf(bytes[i - 1]) * ALPHA + classOf(bytes[i])];
  }
  return s;
}

export const bytesToText = (bytes) =>
  Array.from(bytes, (b) => (b >= 32 && b < 127) || b === 10 ? String.fromCharCode(b) : "·").join("");

export const textToBytes = (text) => new TextEncoder().encode(text);

/**
 * Crib dragging. Slide a guessed fragment of one message along ct1 XOR ct2 and
 * read off what the other message must say at that offset. This is the manual
 * version of the attack, and the reason nonce reuse is fatal rather than merely
 * careless: you never need the key.
 */
export function dragCrib(xored, crib, offset) {
  const out = new Uint8Array(Math.max(0, Math.min(crib.length, xored.length - offset)));
  for (let i = 0; i < out.length; i++) out[i] = xored[offset + i] ^ crib[i];
  return out;
}

/** Every offset where a crib produces plausible English in the other message. */
export function rankCribOffsets(xored, crib, limit = 5) {
  const results = [];
  for (let off = 0; off + crib.length <= xored.length; off++) {
    const other = dragCrib(xored, crib, off);
    results.push({ offset: off, text: bytesToText(other), score: englishScore(other) / crib.length });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Automatic recovery of both messages from their XOR, with no key and no crib.
 *
 * Beam search over the keystream: at each position every one of the 256
 * possible key bytes produces a candidate character in *both* messages at once,
 * and each is scored against the English bigram model. Only the best `beamWidth`
 * partial keystreams survive to the next position. Two overlapping constraints
 * on the same unknown byte is what makes this tractable — one ciphertext alone
 * would be unbreakable.
 *
 * `known` optionally pins keystream bytes (from a crib you already trust):
 * an array where a non-null entry fixes that position.
 */
export function breakTwoTimePad(
  ct1, ct2,
  { beamWidth = 400, known = null, restarts = 4, iterations = 30000 } = {}
) {
  const n = Math.min(ct1.length, ct2.length);
  const SP = classOf(32);
  let beam = [{ key: [], score: 0, a1: SP, b1: SP, a2: SP, b2: SP }];

  for (let i = 0; i < n; i++) {
    const next = [];
    const fixed = known && known[i] != null ? known[i] : null;
    for (const cand of beam) {
      const ctx1 = (cand.a1 * ALPHA + cand.b1) * ALPHA;
      const ctx2 = (cand.a2 * ALPHA + cand.b2) * ALPHA;
      for (let k = 0; k < 256; k++) {
        if (fixed !== null && k !== fixed) continue;
        const p1 = ct1[i] ^ k;
        const p2 = ct2[i] ^ k;
        const pen = bytePenalty(p1) + bytePenalty(p2);
        if (pen < -20) continue; // both impossible: not worth carrying
        const c1 = classOf(p1);
        const c2 = classOf(p2);
        // Trigrams only during the sweep. The word bonus is a large reward that
        // only lands when a word ends, which skews pruning against candidates
        // part-way through a correct word; it is applied by the repair passes
        // below instead, where the whole line is visible at once.
        const score = cand.score + pen + TRIGRAM[ctx1 + c1] + TRIGRAM[ctx2 + c2];
        next.push({ prev: cand, score, c1, c2, k });
      }
    }
    if (next.length === 0) throw new Error(`beam collapsed at position ${i}`);
    next.sort((a, b) => b.score - a.score);
    beam = next.slice(0, beamWidth).map((c) => ({
      key: [...c.prev.key, c.k],
      score: c.score,
      a1: c.prev.b1, b1: c.c1,
      a2: c.prev.b2, b2: c.c2,
    }));
  }

  // Alternate the two repair passes. Orientation and local errors interfere:
  // junk bytes hide the junctions the orientation pass looks for, and a wrong
  // orientation makes the local pass "fix" text towards the wrong message.
  // A couple of rounds of each settles it.
  let keystream = refineKeystream(
    ct1, ct2,
    fixOrientation(ct1, ct2, Uint8Array.from(beam[0].key), { known }),
    { known }
  );
  let bestScore = objectiveScore(ct1, ct2, keystream);
  // Restart the annealer a few times and keep the best run. One run can end in
  // a poor basin; the spread between runs is large enough to be worth the
  // seconds it costs, and every candidate is compared on the same objective.
  for (let attempt = 0; attempt < restarts; attempt++) {
    const candidate = refineKeystream(
      ct1, ct2,
      fixOrientation(ct1, ct2, annealKeystream(ct1, ct2, keystream, { known, iterations }), { known }),
      { known }
    );
    const score = objectiveScore(ct1, ct2, candidate);
    if (score > bestScore) {
      bestScore = score;
      keystream = candidate;
    }
  }
  return {
    keystream,
    m1: xorBytes(ct1.subarray(0, n), keystream),
    m2: xorBytes(ct2.subarray(0, n), keystream),
    score: beam[0].score,
  };
}

/**
 * Resolves the orientation ambiguity, which is the one genuinely hard part.
 *
 * The scoring objective is symmetric in the two messages: swapping which
 * plaintext is "first" from some position onwards costs nothing, because the
 * pair of characters produced is the same either way. So the search happily
 * emits the first half of message one followed by the second half of message
 * two, and it is not wrong so much as unoriented — the *set* of plaintexts is
 * right at every position, the labelling is not.
 *
 * Fixing it needs a coordinated move, not a better local score: inside a
 * wrongly-oriented stretch, flipping any single byte back makes that byte
 * worse, so byte-at-a-time refinement cannot climb out. This searches over
 * whole segments instead, accepting any contiguous flip that improves the
 * global objective, and repeats until nothing does.
 *
 * The one thing this cannot resolve is the global flip - which recovered
 * message is "the first" is not determined by the ciphertexts at all.
 */
export function fixOrientation(ct1, ct2, keystream, { known = null } = {}) {
  const n = keystream.length;
  const key = Uint8Array.from(keystream);
  // Flipping position i means "message one actually said what we assigned to
  // message two", which is a single, cheap edit to the keystream.
  const flipped = (k, i) => k[i] ^ (ct1[i] ^ ct2[i]);

  let best = objectiveScore(ct1, ct2, key);
  let improved = true;
  while (improved) {
    improved = false;
    // Try flipping every contiguous run [i, j). A wrong orientation always
    // covers a stretch, never a lone byte, and inside such a stretch no single
    // byte can be flipped back profitably - which is exactly why byte-at-a-time
    // refinement gets stuck and a segment move does not.
    for (let i = 0; i < n; i++) {
      if (known && known[i] != null) continue;
      for (let j = i + 1; j <= n; j++) {
        // A pinned position (from a crib) fixes the orientation of the segment
        // containing it, so a flip crossing one is not a candidate at all.
        if (known && known[j - 1] != null) break;
        const trial = Uint8Array.from(key);
        for (let t = i; t < j; t++) trial[t] = flipped(key, t);
        const s = objectiveScore(ct1, ct2, trial);
        if (s > best + 1e-9) {
          key.set(trial);
          best = s;
          improved = true;
        }
      }
    }
  }
  return key;
}

/**
 * The same attack with more than two messages under the one nonce, which is
 * what nonce reuse looks like in practice: a counter reset, a re-imaged VM, a
 * device that starts from zero at every boot. It is also far easier than the
 * two-message case, and worth separating for an honest reason - with k
 * ciphertexts, every candidate byte for a keystream position is checked against
 * k characters at once, so the right one stands out on column statistics alone
 * and there is no orientation ambiguity to resolve. Two messages is the hard
 * case precisely because there is so little evidence per position.
 *
 * Returns the recovered keystream and every message.
 */
export function breakManyTimePad(ciphertexts, { known = null, rounds = 30 } = {}) {
  const n = Math.min(...ciphertexts.map((c) => c.length));
  const key = new Uint8Array(n);

  // Pass one: choose each byte on its column alone, ignoring context.
  for (let i = 0; i < n; i++) {
    if (known && known[i] != null) {
      key[i] = known[i];
      continue;
    }
    let bestK = 0;
    let bestS = -Infinity;
    for (let k = 0; k < 256; k++) {
      let s = 0;
      for (const ct of ciphertexts) s += bytePenalty(ct[i] ^ k);
      if (s > bestS) {
        bestS = s;
        bestK = k;
      }
    }
    key[i] = bestK;
  }

  // Pass two: re-decide each byte with its neighbours known, using the full
  // trigram and word model across every message. Repeat until stable.
  const scoreAt = (k, i) => {
    let s = 0;
    for (const ct of ciphertexts) {
      const p = new Uint8Array(n);
      for (let j = 0; j < n; j++) p[j] = ct[j] ^ k[j];
      s += localTermsSingle(p, i, n);
    }
    return s;
  };

  for (let round = 0; round < rounds; round++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (known && known[i] != null) continue;
      const original = key[i];
      let bestK = original;
      let bestS = scoreAt(key, i);
      for (let k = 0; k < 256; k++) {
        if (k === original) continue;
        key[i] = k;
        const s = scoreAt(key, i);
        if (s > bestS) {
          bestS = s;
          bestK = k;
        }
      }
      key[i] = bestK;
      if (bestK !== original) changed = true;
    }
    if (!changed) break;
  }

  return {
    keystream: key,
    messages: ciphertexts.map((ct) => xorBytes(ct.subarray(0, n), key)),
  };
}

/** The single-message version of localTerms: terms around position i. */
function localTermsSingle(p, i, n) {
  const isLetter = (b) => (b >= 97 && b <= 122) || (b >= 65 && b <= 90);
  let lo = i;
  while (lo > 0 && isLetter(p[lo - 1])) lo--;
  let hi = i + 1;
  while (hi < n && isLetter(p[hi])) hi++;
  const cls = (j) => (j < 0 ? classOf(32) : classOf(p[j]));
  let s = bytePenalty(p[i]);
  for (let j = i; j < Math.min(n, i + 3); j++) {
    s += TRIGRAM[(cls(j - 2) * ALPHA + cls(j - 1)) * ALPHA + cls(j)];
  }
  // lo/hi were grown to word boundaries, so a run touching them is only a
  // genuine fragment when it also touches the start or end of the message.
  // hi was grown to a word boundary, so a run touching it is only a genuine
  // fragment when it also touches the end of the message. The start of the
  // message is a real word boundary and is scored normally.
  return s + wordBonus(p.subarray(lo, hi), { partialEnd: hi === n });
}

/**
 * The part of objectiveScore that can change when a single keystream byte at
 * position i is altered: the byte penalties there, the three trigram terms
 * whose window covers i, and the word score of the surrounding region.
 *
 * The region is grown outwards to the nearest non-letter on each side, so it
 * contains whole words. That makes the delta *exact* rather than an
 * approximation - which matters, because an inexact local score is what made
 * an earlier refinement pass drift away from the global optimum it claimed to
 * be climbing.
 */
export function localTerms(ct1, ct2, key, i) {
  const n = key.length;
  const p1 = (j) => ct1[j] ^ key[j];
  const p2 = (j) => ct2[j] ^ key[j];
  const isLetter = (b) => (b >= 97 && b <= 122) || (b >= 65 && b <= 90);

  let lo = i;
  while (lo > 0 && (isLetter(p1(lo - 1)) || isLetter(p2(lo - 1)))) lo--;
  let hi = i + 1;
  while (hi < n && (isLetter(p1(hi)) || isLetter(p2(hi)))) hi++;

  const cls = (j) => (j < 0 ? classOf(32) : classOf(p1(j)));
  const cls2 = (j) => (j < 0 ? classOf(32) : classOf(p2(j)));

  let s = bytePenalty(p1(i)) + bytePenalty(p2(i));
  for (let j = i; j < Math.min(n, i + 3); j++) {
    s += TRIGRAM[(cls(j - 2) * ALPHA + cls(j - 1)) * ALPHA + cls(j)];
    s += TRIGRAM[(cls2(j - 2) * ALPHA + cls2(j - 1)) * ALPHA + cls2(j)];
  }
  const seg1 = new Uint8Array(hi - lo);
  const seg2 = new Uint8Array(hi - lo);
  for (let j = lo; j < hi; j++) {
    seg1[j - lo] = p1(j);
    seg2[j - lo] = p2(j);
  }
  const ends = { partialEnd: hi === n };
  return s + wordBonus(seg1, ends) + wordBonus(seg2, ends);
}

/**
 * Simulated annealing over the keystream, used to finish what the beam search
 * starts. The beam commits to a prefix before it has seen the rest of the line,
 * and lands in a basin that no single-byte change improves - measurably so: on
 * the demo messages the beam's output scores around 88 where the true
 * keystream scores 110 under the same objective, so the gap is search, not
 * model.
 *
 * Two move types, because the two failure modes are different in kind: change
 * one byte (a local slip) and flip a contiguous segment's orientation (the two
 * messages swapping roles). Accepting the occasional worsening move is what
 * gets it out of the basin; the best keystream ever seen is what is returned.
 */
export function annealKeystream(ct1, ct2, keystream, { iterations = 400000, known = null, random = Math.random } = {}) {
  const n = keystream.length;
  const cur = Uint8Array.from(keystream);
  let curScore = objectiveScore(ct1, ct2, cur);
  let best = Uint8Array.from(cur);
  let bestScore = curScore;

  const canChange = (i) => !(known && known[i] != null);

  for (let it = 0; it < iterations; it++) {
    const temperature = 3.5 * (1 - it / iterations) + 0.02;
    const trial = Uint8Array.from(cur);

    if (random() < 0.7) {
      // Nudge one byte. Only the terms around i can move, so the change in
      // score is computed locally instead of rescoring the whole line - which
      // is what makes a useful number of iterations affordable.
      const i = Math.floor(random() * n);
      if (!canChange(i)) continue;
      const before = localTerms(ct1, ct2, cur, i);
      trial[i] = Math.floor(random() * 256);
      const after = localTerms(ct1, ct2, trial, i);
      const delta = after - before;
      if (delta > 0 || random() < Math.exp(delta / temperature)) {
        cur[i] = trial[i];
        curScore += delta;
        if (curScore > bestScore) {
          bestScore = curScore;
          best.set(cur);
        }
      }
      continue;
    } else {
      // Flip the orientation of a random contiguous run. A run may not cross a
      // pinned position: half-flipping a segment around a fixed byte produces
      // an orientation that is inconsistent rather than merely different.
      const i = Math.floor(random() * n);
      if (!canChange(i)) continue;
      const len = 1 + Math.floor(random() * Math.min(n - i, 24));
      for (let t = i; t < i + len; t++) {
        if (!canChange(t)) break;
        trial[t] = cur[t] ^ (ct1[t] ^ ct2[t]);
      }
    }

    const s = objectiveScore(ct1, ct2, trial);
    if (s > curScore || random() < Math.exp((s - curScore) / temperature)) {
      cur.set(trial);
      curScore = s;
      if (s > bestScore) {
        bestScore = s;
        best.set(trial);
      }
    }
  }
  return best;
}

/**
 * Second pass over a candidate keystream. The beam search only ever sees text
 * to the left of the position it is deciding, so one unlucky choice drags the
 * rest of the message off course. Here every byte is re-chosen with the
 * characters on *both* sides already known, repeatedly, until nothing moves.
 *
 * It hill-climbs the same objectiveScore the rest of the pipeline is judged
 * by. An earlier version optimised a cheaper windowed approximation, which
 * quietly drifted: it kept reporting improvements while the global score fell.
 */
export function refineKeystream(ct1, ct2, keystream, { known = null, rounds = 12 } = {}) {
  const n = keystream.length;
  const key = Uint8Array.from(keystream);
  let best = objectiveScore(ct1, ct2, key);

  for (let round = 0; round < rounds; round++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (known && known[i] != null) continue;
      const original = key[i];
      let bestK = original;
      for (let k = 0; k < 256; k++) {
        if (k === original) continue;
        key[i] = k;
        const s = objectiveScore(ct1, ct2, key);
        if (s > best + 1e-9) {
          best = s;
          bestK = k;
        }
      }
      key[i] = bestK;
      if (bestK !== original) changed = true;
    }
    if (!changed) break;
  }
  return key;
}

// ============================================================================
// Attack 4: SHA-256 and length extension.
// ============================================================================

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const IV256 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

function compress(h, block) {
  const w = new Uint32Array(64);
  for (let i = 0; i < 16; i++) {
    w[i] = (block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3];
  }
  for (let i = 16; i < 64; i++) {
    const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
    const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  let [a, b, c, d, e, f, g, hh] = h;
  for (let i = 0; i < 64; i++) {
    const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
    const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    hh = g; g = f; f = e;
    e = (d + t1) >>> 0;
    d = c; c = b; b = a;
    a = (t1 + t2) >>> 0;
  }
  const out = new Uint32Array(8);
  const cur = [a, b, c, d, e, f, g, hh];
  for (let i = 0; i < 8; i++) out[i] = (h[i] + cur[i]) >>> 0;
  return out;
}

/**
 * The Merkle-Damgard padding: 0x80, zeroes, then the message length in bits as
 * a 64-bit big-endian integer. The attack turns entirely on this being a
 * function of the length alone, which the attacker knows or can guess.
 */
export function shaPadding(messageLengthBytes) {
  const padLen = messageLengthBytes % 64 < 56
    ? 56 - (messageLengthBytes % 64)
    : 120 - (messageLengthBytes % 64);
  const pad = new Uint8Array(padLen + 8);
  pad[0] = 0x80;
  const bits = BigInt(messageLengthBytes) * 8n;
  for (let i = 0; i < 8; i++) {
    pad[pad.length - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  }
  return pad;
}

/**
 * SHA-256. `state` and `priorLength` exist for the attack: they let us resume
 * the hash from a digest we did not compute ourselves, which is exactly the
 * property a Merkle-Damgard construction should not be trusted with.
 */
export function sha256(message, { state = IV256, priorLengthBytes = 0 } = {}) {
  const padded = new Uint8Array(message.length + shaPadding(priorLengthBytes + message.length).length);
  padded.set(message);
  padded.set(shaPadding(priorLengthBytes + message.length), message.length);
  let h = Uint32Array.from(state);
  for (let i = 0; i < padded.length; i += 64) h = compress(h, padded.subarray(i, i + 64));
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (h[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (h[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (h[i] >>> 8) & 0xff;
    out[i * 4 + 3] = h[i] & 0xff;
  }
  return out;
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const fromHex = (hex) =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

/** The mistake: a MAC built by prefixing the secret to the message. */
export function naiveMac(secret, message) {
  const buf = new Uint8Array(secret.length + message.length);
  buf.set(secret);
  buf.set(message, secret.length);
  return sha256(buf);
}

export function naiveMacVerify(secret, message, mac) {
  return toHex(naiveMac(secret, message)) === toHex(mac);
}

/**
 * Length extension. Given only (message, MAC) and the *length* of the secret,
 * resume the hash from the published digest and append whatever you like. The
 * forged message carries the original glue padding in the middle, which the
 * server happily accepts because it is just bytes to the parser.
 */
export function lengthExtend(originalMessage, originalMac, secretLength, suffix) {
  const state = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    state[i] =
      ((originalMac[i * 4] << 24) | (originalMac[i * 4 + 1] << 16) |
       (originalMac[i * 4 + 2] << 8) | originalMac[i * 4 + 3]) >>> 0;
  }
  const glue = shaPadding(secretLength + originalMessage.length);
  const forgedMessage = new Uint8Array(originalMessage.length + glue.length + suffix.length);
  forgedMessage.set(originalMessage);
  forgedMessage.set(glue, originalMessage.length);
  forgedMessage.set(suffix, originalMessage.length + glue.length);

  const priorLengthBytes = secretLength + originalMessage.length + glue.length;
  return { forgedMessage, glue, mac: sha256(suffix, { state, priorLengthBytes }) };
}

/** The fix. HMAC-SHA-256, so the secret is not simply a hash prefix. */
export function hmacSha256(key, message) {
  let k = key.length > 64 ? sha256(key) : key;
  const block = new Uint8Array(64);
  block.set(k);
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

// ============================================================================
// Attack 5: timing side channel.
// ============================================================================

/** The mistake: bails out at the first mismatch, so the runtime leaks the prefix. */
export function naiveCompare(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** The fix: always touches every byte, and the branch does not depend on data. */
export function constantTimeCompare(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * The comparison the demo actually times. `work` inflates the per-byte cost so
 * that the difference between "matched 3 bytes" and "matched 4 bytes" is bigger
 * than the browser's clock resolution. It amplifies a real effect; it does not
 * invent one. On a real network service the same signal is there, just buried
 * under jitter that you beat with more samples instead.
 */
export function timedCompare(secret, guess, { constantTime = false, work = 600 } = {}) {
  let acc = 0;
  let diff = 0;
  const n = Math.min(secret.length, guess.length);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < work; j++) acc = (acc + secret[i] * 31 + j) & 0xffff;
    if (constantTime) {
      diff |= secret[i] ^ guess[i];
    } else if (secret[i] !== guess[i]) {
      return { equal: false, acc };
    }
  }
  return { equal: constantTime ? diff === 0 && secret.length === guess.length : secret.length === guess.length, acc };
}
