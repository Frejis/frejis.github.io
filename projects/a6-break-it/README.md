# Break It Yourself

Five ways to use good cryptography badly, each with the attack that follows,
running live in the browser.

**[▶ Open the live demo](./index.html)**

## What you are looking at

Five cards, each one a mistake a real system has shipped. An image encrypted
with AES that you can still read. Two messages that give up their contents
because a nonce was used twice. A server that leaks a whole plaintext while
answering nothing but "bad padding". A signature forged onto a message the
signer never saw. A secret token guessed one character at a time by watching a
clock.

Nothing is staged. AES-128 and SHA-256 are implemented from scratch in
`attacks.js` so the attacks can reach inside them, and the same functions the
page calls are the ones the tests check against published vectors. The query
count the padding oracle reports on screen is the real number of oracle
calls the attack made, counted as it runs, not a canned figure.

## Why this was hard

The padding oracle has a false positive that most descriptions skip: the last
byte of a block can produce a valid `0x01` that is really `0x02 0x02`, so the
attack perturbs the neighbouring byte and re-asks. There is a test with a
plaintext ending in `0x02` bytes that fails without it.

Recovering two messages from a single reused keystream was the genuinely hard
part, and the honest answer is that it half-works. The scoring objective is
symmetric in the two messages, so splicing them together at a word boundary
costs nothing and often scores *higher* than the truth. I measured this rather
than guessed: the beam search's output scored 48 nats above the real keystream
under a character model, which proves the problem is the model, not the search.
Adding a word lexicon put the truth back on top, and segment-flip moves fix the
orientation that single-byte refinement cannot escape. Two messages still only
reaches about 60% of characters, so the page leads with the many-message case,
where every extra ciphertext constrains the same keystream byte again and
recovery is near-exact.

## Run it

Open `index.html` in a browser. No build step, no dependencies, no server
required. All five attacks run on load.

Tests:

```
node --test projects/a6-break-it/*.test.js
```

The suite covers AES against the FIPS-197 and NIST SP 800-38A vectors and
cross-checked against WebCrypto, SHA-256 against known digests including the
empty string and against WebCrypto at every padding boundary, the padding
oracle recovering a plaintext exactly, length extension producing a MAC the
naive verifier accepts, and HMAC matching WebCrypto.

## What this is not

Educational code with deliberately weak parameters. Do not copy any of it into
production.

- The AES and SHA-256 implementations are written to be *readable and
  attackable*, not safe. They are variable-time and make no attempt to resist
  the side channels this page demonstrates.
- The padding oracle, the naive MAC and the early-exit comparison are the bugs,
  not accidents.
- The timing attack amplifies a real effect. Each comparison does inflated
  per-byte work and is repeated hundreds of times, because browser clocks are
  deliberately coarse. The signal exists in a normal comparison too; it is just
  below the timer's resolution. The final character is not recovered by timing
  at all: every byte's work happens before its comparison, so at the last
  position a right and a wrong guess cost the same. With the other seven known
  there are sixteen candidates left, and the demo says so on the page.
- The two-message keystream recovery is statistical and imperfect, as above.
  The many-message version is the one that works properly.
- Every key here is generated in the page and thrown away. Nothing is stored,
  sent, or reused.
