# Meter Telemetry

A bit-packed radio frame for a smart utility meter, in the style of wireless
M-Bus, sized and budgeted against a battery with a design goal of surviving
well over a decade in the field on one cell.

**[▶ Open the live demo](./index.html)**

## What you are looking at

A reading — meter ID, timestamp, cumulative volume, flow rate, battery level,
five alarm flags — packed by hand into 13 bytes plus a 2-byte CRC, field by
field, at
the bit width each one actually needs. The byte map at the top colours every
bit by the field it belongs to; move a slider and watch the exact bits change.
Below it: the same reading sent as a full frame and as a delta against the
previous one, a corruption playground where you flip bits and watch the CRC
and the decode fail, and a battery-life model that turns frame size and
transmit interval into years before someone has to drive out and change the
meter.

## Why this was hard

Laying out fields at 11 and 5 and 1-bit widths across byte boundaries is
exactly the kind of code that looks trivial and is not: get the shift or the
field order wrong and a full-value field bleeds one bit into its neighbour,
silently. The `a field at its maximum does not overflow into its neighbour`
test in `frame.test.js` is written against precisely that bug — every field
at its maximum at once, every field checked individually afterwards.

The other genuine decision was the CRC. Real wireless M-Bus uses CRC-16/EN13757,
which reflects both input and output; I chose CRC-16/CCITT-FALSE instead (poly
`0x1021`, init `0xFFFF`, no reflection, no XOR-out) because its bit-by-bit
division is something you can read off the register and believe is correct,
where a reflected CRC hides the same arithmetic behind a bit-reversal step
that would add code without adding anything to demonstrate. It is a real,
named CRC, checked against its published test vector (`CRC-16/CCITT-FALSE` of
`"123456789"` is `0x29B1`) — it is just not the specific CRC the real protocol
uses.

The undetected-corruption number is the one that actually matters to an
embedded engineer and is easy to get wrong by never asking about it at all: a
16-bit CRC misses roughly 1 in 65536 corrupted frames, so at a few percent bit
error rate over thousands of frames a handful genuinely get through. The
channel simulation counts all three outcomes explicitly and a test asserts
`intact + caughtByCrc + undetected === total` exactly, every run, at a fixed
seed.

## Run it

Open `index.html` in a browser. No build step, no dependencies, no server
required.

Tests, from the repository root:

```
node --test "projects/a13-meter-telemetry/*.test.js"
```

(passing a bare directory to `--test` is rejected by Node 24 on Windows; the
wildcard above works, but only quoted — cmd.exe expands an unquoted `*` itself
and hands node a MODULE_NOT_FOUND instead of a glob.)

They cover BitWriter/BitReader round-tripping at non-aligned widths, full and
delta frame round-trips at minimum, maximum and all-flags-set values, the
overflow-into-neighbour case above, delta frames coming out strictly smaller
than full frames for a typical consecutive reading, a delta jump too large
for the 12-bit volume field being rejected rather than silently truncated or
left to throw uncaught past the UI, the CRC-16 test vector, every single-bit
flip in a frame being caught by the CRC, the seeded PRNG being deterministic,
and the channel accounting being exact.

## What this is not

- **Not real wireless M-Bus.** The field layout, frame structure and CRC
  polynomial are this project's own design, in the spirit of that protocol
  family rather than a compliant implementation of it. Do not point a real
  meter reader at frames this code produces.
- **The power model is illustrative, not a datasheet simulation.** It assumes
  a fixed per-transmission wake overhead, a flat transmit current, a flat
  sleep current, a bit rate, and a flat self-discharge rate, all stated as
  constants in `power.js` with their units in the name. Real hardware has
  ramp-up curves, temperature dependence, retries and duty-cycle regulations
  that this model does not touch. Treat the years it reports as an order of
  magnitude that responds sensibly to frame size and interval, not a number
  an engineer would sign off on.
- **Self-discharge assumption.** `selfDischargeRatePerYear` (default 1%/year)
  is an order-of-magnitude figure for a lithium thionyl chloride (Li-SOCl2)
  primary cell, the usual choice for multi-year meter deployments, taken from
  the kind of loss vendor datasheets and application notes (e.g. Tadiran,
  Saft) describe for storage/passivation loss on these cells — not a
  measurement of any specific part number. Without this term the model lets
  battery life grow without bound as the transmit interval increases, which
  no real cell does: past some point the meter is asleep almost all the
  time and the battery is limited by sitting there, not by what it sends.
  With the term, life asymptotes towards `1 / selfDischargeRatePerYear`
  years as the interval grows, and the full-vs-delta advantage correctly
  collapses towards ×1 in that regime, because payload size stops being the
  bottleneck.
- **The radio channel is a synthetic i.i.d. bit-flip model**, not a
  simulation of fading, multipath or interference. Real channels have
  correlated bursts of errors, not independent per-bit ones; this is enough
  to make the CRC's blind spot visible, not to model a real link budget.
- Every constant is a named, overridable field in `power.js` and `channel.js`
  — nothing on the page is a number typed once into the README and never
  checked against the code that supposedly produced it.
