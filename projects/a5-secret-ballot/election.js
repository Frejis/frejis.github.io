// election.js — ballot creation, the public bulletin board, tallying and
// verification. No DOM: this is the part app.js wires up to the page.
//
// Encoding choice: one ciphertext PER OPTION, each carrying 0 or 1.
// A voter picking option i submits N ciphertexts (N = number of options):
// enc(1) for their chosen option, enc(0) for every other one. Tallying an
// option just multiplies that option's column of ciphertexts together and
// decrypts once. This costs more ciphertexts per ballot than the
// "single packed integer" alternative (m = sum B^i, one ciphertext per
// ballot), but it keeps every number on screen small enough to read as a
// single plaintext bit's encryption, and it keeps the "two votes for the
// same option look different" demonstration to a single ciphertext
// comparison rather than a multi-digit-extraction exercise. See the README
// for the explicit trade-off (and its very real weakness: nothing here
// stops a ballot's 0/1 ciphertexts from secretly encrypting other values —
// that needs a zero-knowledge range proof this project does not build).

import { encrypt, decrypt, addCiphertexts } from "./paillier.js";

/**
 * Creates a ballot: one Paillier ciphertext per option, all 0 except a 1 in
 * the chosen slot. Returns the ballot plus the randomness used for each
 * ciphertext (so the demo can show "what an attacker sees" vs. the full
 * picture without re-deriving anything).
 */
export function createBallot({ voter, optionIndex, options, publicKey }) {
  if (optionIndex < 0 || optionIndex >= options.length) {
    throw new Error(`optionIndex ${optionIndex} out of range for ${options.length} options`);
  }
  const ciphertexts = options.map((_, i) => encrypt(i === optionIndex ? 1n : 0n, publicKey));
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    voter,
    castAt: Date.now(),
    ciphertexts, // array of BigInt, one per option, in option order
  };
}

/** In-memory public bulletin board: append-only except for the "corrupt" demo. */
export class BulletinBoard {
  constructor(options) {
    this.options = options;
    this.ballots = [];
  }

  cast(ballot) {
    this.ballots.push(ballot);
    return ballot;
  }

  list() {
    return [...this.ballots];
  }

  get(id) {
    return this.ballots.find((b) => b.id === id) || null;
  }

  /**
   * Flips a ballot's ciphertext for one option by re-encrypting a different
   * plaintext into that slot — simulating a tampered bulletin board entry.
   * Returns false if the ballot does not exist.
   */
  corrupt(id, publicKey, optionIndex = 0) {
    const ballot = this.get(id);
    if (!ballot) return false;
    const current = ballot.ciphertexts[optionIndex];
    // Multiply in an encryption of 1 so the stored sum silently changes —
    // exactly the kind of tamper verification is meant to catch.
    ballot.ciphertexts[optionIndex] = addCiphertexts(current, encrypt(1n, publicKey), publicKey.n);
    ballot._corrupted = true;
    return true;
  }

  clear() {
    this.ballots = [];
  }
}

/**
 * Tallies the board homomorphically: for each option, multiplies every
 * ballot's ciphertext for that option together (mod n^2), then decrypts
 * once per option. Returns { perOption: BigInt[], accumulators: BigInt[] }
 * where accumulators are the running product after each ballot is folded
 * in — useful for animating the walk.
 */
export function tally(board, publicKey, privateKey) {
  const n = publicKey.n;
  const numOptions = board.options.length;
  const accumulatorSteps = []; // accumulatorSteps[optionIndex] = [acc after ballot 0, ballot 1, ...]
  const finalCiphertexts = [];

  for (let opt = 0; opt < numOptions; opt++) {
    let acc = encrypt(0n, publicKey); // encryption of the identity element, 0
    const steps = [];
    for (const ballot of board.ballots) {
      acc = addCiphertexts(acc, ballot.ciphertexts[opt], n);
      steps.push(acc);
    }
    accumulatorSteps.push(steps);
    finalCiphertexts.push(acc);
  }

  const perOption = finalCiphertexts.map((c) => Number(decrypt(c, privateKey)));

  return { perOption, finalCiphertexts, accumulatorSteps };
}

/**
 * Recomputes the tally from the board independently (as any observer with
 * the public key and the private key could) and checks it matches the
 * announced result. Returns { ok, recomputed, mismatchOptions }.
 */
export function verifyTally(board, publicKey, privateKey, announcedPerOption) {
  const { perOption } = tally(board, publicKey, privateKey);
  const mismatchOptions = [];
  for (let i = 0; i < perOption.length; i++) {
    if (perOption[i] !== announcedPerOption[i]) mismatchOptions.push(i);
  }
  return { ok: mismatchOptions.length === 0, recomputed: perOption, mismatchOptions };
}
