# Matching Engine

A limit order book with price-time priority matching, built from scratch, driving a live depth ladder — with every operation timed so the page can show what actually matters for a system like this: not the average latency, but the tail.

**[▶ Open the live demo](./index.html)**

## What you are looking at

On the left, a classic order book: sells stacked above buys, a highlighted spread between them, quantity bars per price level. Submit a limit order, a market order, or cancel one, and watch the book and trade tape update. On the right, the actual point of the page: press "Run 50,000 orders" and a seeded, realistic stream of order flow — mostly passive orders resting near the touch, some aggressive orders that cross the spread, some cancels — runs through the same engine while every operation's cost is timed. The result is a latency histogram on a **logarithmic x-axis**, with p50, p99 and p99.9 marked. Most orders are fast; the slowest 1 in 1000 is what ruins your day, and that is the number this page is built to show honestly.

**What is actually plotted is per-operation cost averaged over batches, not per-operation timings.** `performance.now()` in a real browser is deliberately coarsened (a Spectre-era side-channel mitigation) to a tick — commonly 0.1ms — that a single order-book operation cannot clear: almost every individual measurement would quantise to exactly 0, with the rest landing on the tick itself. Timing one operation at a time is therefore not possible; instead the page measures **batches** of `K` operations with one `performance.now()` pair and divides by `K`. `K` is calibrated at runtime against this browser's own measured clock resolution — never hardcoded, since the tick differs across browsers — and the resolution it finds is shown on the page. The stats are honestly labelled as what they are: per-operation cost *averaged over each batch*, with percentiles computed *across batches*. That is smoother than a genuine per-operation distribution and cannot show a true single-operation outlier — a real limitation, stated rather than hidden.

## Why this was hard

- **Matching has to be correct, or the whole thing is worthless.** A buy at price P must match resting sells at ask ≤ P, best price first, and within a price level, strictly in arrival order (FIFO) — partial fills leave the untouched remainder resting in its original queue position. `orderbook.test.js` checks each of these directly, plus two invariants that only show up under sustained random pressure: across a 20,000-action seeded run, every trade fills exactly one buyer and one seller by the same quantity and no order ever fills past its original size (conservation), and the book is never crossed — best bid stays strictly below best ask — after any single operation, checked continuously rather than only at the end.
- **Cancelling an order must not disturb anyone else's queue position.** Each price level keeps resting orders in a plain array in arrival order and advances a `head` pointer past dead (filled or cancelled) orders instead of physically removing them from the middle — removing an order from the middle of an array and shifting everyone behind it would silently renumber their position in the queue, which is exactly the bug price-time priority cannot tolerate.
- **Measuring latency without the measurement lying to itself.** `LatencyRecorder` writes into a preallocated `Float64Array` by index rather than pushing onto a growing array, because a backing-store reallocation (or a GC pause it can trigger) landing inside the operation being timed would perturb the very thing being measured. Percentiles are computed from a sorted *copy*, never the live array, using linear interpolation between the two bracketing samples (`rank = p * (n - 1)`) — the same convention NumPy's default and most APM tools use. It matters: p99.9 on a 1000-sample array is not "index 999" (the max), it is 99.9% of the way from sample 998 to sample 999, and the two conventions disagree everywhere except at p50 on an odd-length array.
- **The clock itself lies, if you let it.** A coarsened `performance.now()` makes per-operation timing meaningless — three quantised values dressed up as a distribution, with `p999/p50` a division by zero that would print the literal string `Infinity`. `calibrateClockResolution` measures the actual tick at runtime (the smallest non-zero gap between successive calls); `calibrateBatchSize` uses that measurement to pick a batch size `K` that clears the tick by a comfortable margin; and `safeRatio` guards every displayed ratio so a zero (or non-finite) denominator prints something sensible instead of `Infinity` reaching the DOM.
- **A log-scale chart, drawn correctly.** Order-matching latency spans several orders of magnitude — most operations are sub-microsecond housekeeping, the tail includes level sweeps and array-splice-triggered level removal — so a linear-axis histogram crushes everything into one spike at the left edge. The chart buckets samples evenly in log-space and places the p50/p99/p99.9 markers by the same log transform as the axis, not by pixel-fraction of the linear range.

## Run it

Open `index.html` in a browser — no build step, no dependencies, no server needed. The book is preloaded so there is something to look at immediately; press "Run 50,000 orders" to populate the latency chart.

Tests, from the repository root:

```
node --test "projects/a12-matching-engine/*.test.js"
```

(passing a bare directory to `--test` is rejected by Node 24 on Windows; the wildcard above works.)

The suite covers: price-time priority (same-price orders fill in arrival order), best-price-first matching, a partial fill leaving the correct remainder resting, a market order sweeping multiple levels and stopping when the book is exhausted, cancel leaving the remaining queue order untouched, the conservation and never-crossed invariants over a long seeded run, the seeded order-flow generator being deterministic for a fixed seed and different across seeds, the documented percentile convention against a known 1..1000 array, the log-histogram bucketer handling a wide dynamic range plus its edge cases (identical samples, non-positive samples, and reporting rather than silently discarding a dropped count), clock-resolution calibration against a fake stepped clock, batch-size calibration clearing a simulated coarse tick, and `safeRatio` never producing `Infinity`/`NaN` for any finite-or-not input pair.

## What this is not

- **Not a production matching engine.** No order types beyond limit/market (no stop, iceberg, or pegged orders), no risk checks, no persistence, no multi-instrument book, no network layer — this is the matching and measurement core, in isolation, to make both legible.
- **The timings are a browser's, not a real exchange's — and they are batch averages, not single-operation timings.** `performance.now()` in a JS engine running in a browser tab measures this implementation's own cost, with JIT warm-up and GC pauses from the rest of the page mixed in, and (per above) a coarsened clock that forces batch-averaged measurement rather than per-operation measurement. It demonstrates the *methodology* (measure the tail, not the mean, and be honest about what the clock can and cannot resolve) — not a number comparable to a co-located C++ matching engine's actual single-order latency.
- **The order-flow generator is a plausible caricature, not a calibrated model.** Its mix of passive/aggressive/cancel actions and price offsets are hand-picked to produce a realistic-looking book, not fit to real market microstructure data.
- **Levels are a sorted array with binary-search insert,** not the hash-map-plus-ordered-index (or skip-list) structure a real book uses at higher order rates — the right trade-off for this demo's scale, not for a venue processing millions of orders a second.
