// paillier.js — the Paillier cryptosystem, implemented from the primitives up.
// Pure BigInt arithmetic, no DOM. Importable by both the browser and Node.
//
// Paillier is additively homomorphic: multiplying two ciphertexts modulo n^2
// and decrypting the result gives the SUM of the two original plaintexts,
// without the decrypting party ever seeing either plaintext. That single
// property is the whole engine behind election.js.
//
// Key generation, encryption and decryption below follow the standard
// textbook construction (Paillier, 1999) with the common simplification
// g = n + 1, which makes encryption cheap without weakening the scheme.

// ---------- small integer helpers ----------

function absBig(a) {
  return a < 0n ? -a : a;
}

/** Extended Euclidean algorithm. Returns [gcd, x, y] such that a*x + b*y = gcd. */
function extendedGcd(a, b) {
  if (b === 0n) return [a, 1n, 0n];
  const [g, x1, y1] = extendedGcd(b, a % b);
  return [g, y1, x1 - (a / b) * y1];
}

export function gcd(a, b) {
  a = absBig(a);
  b = absBig(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

export function lcm(a, b) {
  return (a / gcd(a, b)) * b;
}

/** Modular inverse of a mod m via extended Euclid. Throws if it does not exist. */
export function modInverse(a, m) {
  a = ((a % m) + m) % m;
  const [g, x] = extendedGcd(a, m);
  if (g !== 1n) throw new Error(`modular inverse does not exist for ${a} mod ${m}`);
  return ((x % m) + m) % m;
}

/** Fast modular exponentiation, base^exp mod m. exp must be non-negative. */
export function modPow(base, exp, m) {
  if (m === 1n) return 0n;
  base = ((base % m) + m) % m;
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % m;
    exp >>= 1n;
    base = (base * base) % m;
  }
  return result;
}

// ---------- randomness ----------

/** A uniformly random BigInt in [0, 2^bits - 1] (no bit forced set). */
export function randomBigIntBits(bits) {
  const byteLen = Math.ceil(bits / 8);
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  // Mask off the excess high bits of the top byte so the value never exceeds
  // 2^bits - 1, then combine into a single BigInt.
  const excessBits = byteLen * 8 - bits;
  bytes[0] &= 0xff >> excessBits;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/** A uniformly random BigInt in [min, max] inclusive, via rejection sampling. */
export function randomBigIntRange(min, max) {
  const range = max - min + 1n;
  const bits = range.toString(2).length;
  let candidate;
  do {
    candidate = randomBigIntBits(bits);
  } while (candidate >= range);
  return min + candidate;
}

// ---------- primality ----------

const SMALL_PRIMES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n];

/** Miller–Rabin primality test. `rounds` witnesses, each error probability <= 4^-rounds. */
export function isProbablePrime(n, rounds = 20) {
  if (n < 2n) return false;
  for (const p of SMALL_PRIMES) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }

  let d = n - 1n;
  let r = 0n;
  while (d % 2n === 0n) {
    d /= 2n;
    r += 1n;
  }

  witnessLoop: for (let i = 0; i < rounds; i++) {
    const a = randomBigIntRange(2n, n - 2n);
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let j = 0n; j < r - 1n; j++) {
      x = modPow(x, 2n, n);
      if (x === n - 1n) continue witnessLoop;
    }
    return false;
  }
  return true;
}

/** Generates a random probable prime with exactly `bits` bits. */
export function generatePrime(bits) {
  for (;;) {
    let candidate = randomBigIntBits(bits) | 1n; // force odd
    candidate |= 1n << BigInt(bits - 1); // force top bit (exact bit length)
    if (isProbablePrime(candidate)) return candidate;
  }
}

// ---------- Paillier key generation ----------

/**
 * Generates a Paillier keypair. `bits` is the size of the modulus n = p*q,
 * so each prime is generated at bits/2. 512 is fine for an interactive demo;
 * a real deployment needs n at least 2048 bits (see README).
 */
export function generateKeypair(bits = 512) {
  const primeBits = Math.floor(bits / 2);
  for (;;) {
    const p = generatePrime(primeBits);
    let q = generatePrime(primeBits);
    while (q === p) q = generatePrime(primeBits);

    const n = p * q;
    const lambda = lcm(p - 1n, q - 1n);
    // g = n + 1 is the standard simplification: L(g^lambda mod n^2) == lambda,
    // so mu is simply lambda's inverse mod n. It only fails (rarely) when
    // lambda has no inverse mod n, in which case we just draw new primes.
    let mu;
    try {
      mu = modInverse(lambda, n);
    } catch {
      continue;
    }

    return {
      publicKey: { n, g: n + 1n },
      privateKey: { lambda, mu, n },
    };
  }
}

// ---------- encrypt / decrypt ----------

/**
 * Encrypts plaintext integer m (0 <= m < n) under publicKey, with fresh
 * randomness r each call. Two encryptions of the same m are, by design,
 * almost never the same ciphertext — that's semantic security, and the
 * "try to cheat" panel in the demo makes it visible.
 */
export function encrypt(m, publicKey, r) {
  const { n, g } = publicKey;
  const n2 = n * n;
  m = ((m % n) + n) % n;
  if (r === undefined) {
    do {
      r = randomBigIntRange(1n, n - 1n);
    } while (gcd(r, n) !== 1n);
  }
  const a = modPow(g, m, n2);
  const b = modPow(r, n, n2);
  return (a * b) % n2;
}

function paillierL(x, n) {
  return (x - 1n) / n;
}

/** Decrypts ciphertext c under privateKey, returning the plaintext integer. */
export function decrypt(c, privateKey) {
  const { lambda, mu, n } = privateKey;
  const n2 = n * n;
  const x = modPow(c, lambda, n2);
  const l = paillierL(x, n);
  return (l * mu) % n;
}

// ---------- homomorphic operations ----------

/** Multiplying ciphertexts mod n^2 adds the underlying plaintexts. */
export function addCiphertexts(c1, c2, n) {
  const n2 = n * n;
  return ((c1 % n2) * (c2 % n2)) % n2;
}

/** Raising a ciphertext to a scalar power mod n^2 multiplies the plaintext by that scalar. */
export function multiplyByScalar(c, k, n) {
  const n2 = n * n;
  return modPow(c, k, n2);
}
