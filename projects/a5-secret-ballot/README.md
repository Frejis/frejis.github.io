# Secret Ballot

A poll where the server adds up every vote without ever being able to read a single one.

**[▶ Open the live demo](./index.html)**

## What you are looking at

Every ballot on the public bulletin board is a real Paillier ciphertext — an
enormous integer, encrypted in your browser. The "tally without decrypting"
button multiplies those integers together, one ballot at a time, and only
decrypts the four running totals at the very end. Nobody, including the
server, ever decrypts a single vote. The identity panel at the top shows the
mechanism directly: `decrypt(encrypt(a) × encrypt(b) mod n²) = a + b`, with
the actual numbers, not a diagram.

## Why this was hard

Paillier is built from primitives this demo implements itself, in BigInt,
rather than importing: Miller–Rabin primality testing, prime generation from
`crypto.getRandomValues`, modular exponentiation by repeated squaring,
modular inverse via the extended Euclidean algorithm, then key generation
(`n = pq`, `g = n+1`, `λ = lcm(p-1, q-1)`, `μ = λ⁻¹ mod n`) and the
encrypt/decrypt/homomorphic-add operations on top. The one design choice
worth calling out: each ballot is **one ciphertext per option** (0 or 1),
rather than packing the whole vote into a single ciphertext as
`m = Σ Bⁱ` for a base `B` larger than the voter count. Packing needs fewer
ciphertexts per ballot and is the more common real-world design, but it
makes every number on screen a multi-digit-extraction puzzle. Per-option
ciphertexts keep every value on the board a legible 0-or-1 encryption, which
matters more for a page meant to be understood in 90 seconds — at the cost
of `O(options)` ciphertexts and homomorphic multiplications per ballot
instead of one.

## Run it

Open `index.html` directly, or serve the repo root with any static file
server. No build step, no dependencies.

Tests, from the repository root:

```
node --test "projects/a5-secret-ballot/*.test.js"
```

Covers modular
inverse and modular exponentiation against known values, Miller–Rabin
against known primes and known composites (including two Carmichael
numbers, which trip up weaker primality tests), encrypt/decrypt round-trips
over many random plaintexts, the homomorphic addition identity across many
random pairs, that encrypting the same plaintext twice gives different
ciphertexts, a full simulated election tallying to the correct per-option
counts, and that corrupting one ballot makes verification fail.

The live demo defaults to a 512-bit modulus so key generation and the
benchmark stay interactive; the benchmark panel also measures 256-bit and
1024-bit for comparison, live, with `performance.now()` — nothing in this
page is a hardcoded number. Real deployments should use 2048 bits or more;
being explicit about that gap is more useful to a reader than hiding it.

## What this is not

This is a working demonstration of homomorphic tallying, not a voting
system, and several things a real election would need are deliberately
absent:

- **No proof that a ballot is well-formed.** A malicious voter's browser
  could encrypt 1000 instead of 1, or a negative number, in any slot, and
  nothing here would catch it. Real systems attach a zero-knowledge range
  proof to every ballot so a verifier can confirm "this ciphertext encrypts
  0 or 1" without learning which. This demo does not build one.
- **No threshold decryption.** One authority holds the entire private key.
  A real deployment splits it across multiple trustees (e.g. Shamir
  sharing) so no single party can decrypt anything alone.
- **No voter authentication.** Anyone can type an alias and cast as many
  ballots as they like; there is no identity or eligibility check.
- **No coercion resistance or receipt-freeness.** A voter can prove to a
  third party which ciphertext was theirs and what it contains, which real
  voting protocols go to considerable lengths to prevent.
- **Small modulus, in-memory board.** 512 bits is a toy size chosen for
  interactivity, and the bulletin board is a JavaScript array in one tab,
  not a distributed, append-only, publicly auditable log.

Treat this as what it is: a correct implementation of additively
homomorphic encryption and the tallying trick it enables, not a system
anyone should run an actual election on.
