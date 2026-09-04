# Sumcheck, step by step

Watch a prover convince a verifier that a sum of 262,144 numbers is correct, while
the verifier looks at exactly one of them.

**[▶ Open the live demo](./index.html)**

## What you are looking at

The sumcheck protocol is a conversation. One side (the prover) has done a huge
computation and states the answer. The other side (the verifier) cannot afford to
redo that computation, so instead it asks a short sequence of questions, each
about one variable at a time, and picks a random number after every answer. If
the prover lied anywhere, it has to keep guessing which random numbers are coming,
and it will not.

The page runs that conversation one round at a time. The grid on the right is the
boolean hypercube the sum is taken over; each round pins one variable to a random
field element and the grid halves. The two bars underneath are the actual count of
field operations each side has performed. The prover's bar doubles with every
extra variable; the verifier's grows by four operations per round. That gap is the
entire reason the protocol exists, and it is why systems like GKR, and the
zk-rollups now settling real money on Ethereum, can hand a chain a proof it can
check in milliseconds for work that took a server seconds or minutes.

## Why this was hard

The mathematics is short, so the difficulty is elsewhere. Three decisions:

1. **Making a cheating prover that is genuinely hard to catch.** A naive "corrupt
   a number" toggle fails in round one and teaches nothing. Both cheats here are
   constructed to pass every individual round check: the lying prover patches
   `s(1)` so each round still adds up to the previous claim, and the round-corrupter
   shifts `s(0)` and `s(1)` by opposite deltas so the sum is preserved. The lie can
   only surface at the final oracle query. That is what actually demonstrates
   soundness.
2. **Counting work honestly.** The op-counter is threaded through the field
   arithmetic itself rather than estimated afterwards, so the bars cannot drift out
   of agreement with what the code did. A single verification is far below the
   clock's resolution, so the benchmark times 500 replays and divides.
3. **Showing 4,096 cells without freezing the page.** Past 128 cells the grid
   drops the numerals and encodes magnitude as colour, and the benchmark yields to
   the event loop between sizes so the button never appears hung.

## Run it

Open `index.html` in a browser, or serve the repository root with any static
server. No build step, no dependencies.

```
node --test "projects/a2-sumcheck/*.test.js"
```

The suite covers field inverse via Fermat, multilinear extension agreeing
with the table at every boolean point and being linear in each variable, the
honest prover verifying for every preset across v = 1..9, both cheats being
rejected, a hand-corrupted transcript being caught at the right round, and
the closed form `v · 2^(v-1)` for the bit-count preset.

Every figure on the page is measured when you press the button. The benchmark and
the soundness experiment print what your machine did, not what mine did.

## What this is not

- **Interactive, not non-interactive.** The verifier picks fresh randomness in
  each round. There is no Fiat-Shamir transform here, so nothing on this page is a
  proof you could publish and have someone else check offline.
- **Not zero-knowledge.** The verifier learns the round polynomials and one
  evaluation of `g`. Sumcheck is a proof of correctness, not of secrecy; the ZK
  part of a zk-rollup comes from machinery layered on top of this.
- **No polynomial commitment.** The final step is modelled as an oracle query:
  the verifier is simply handed `g(r₁..r_v)`. A real system replaces that with a
  commitment scheme, and that is usually where most of the cost lives.
- **A small field on purpose.** p = 2³¹−1 keeps every number on screen readable.
  It also makes the soundness bound `d·v/p` weak by production standards (about
  10⁻⁹ here); real deployments use a field of 128 bits or more, or repeat over an
  extension field.
- **A single multilinear polynomial**, not the layered circuit of full GKR. This
  is the inner loop of that protocol, isolated so it can be watched.
