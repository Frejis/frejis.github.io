# Shrink Lab

A property-based testing engine built from scratch, with the one part nobody usually gets to watch — shrinking a huge random failure down to the smallest input that still breaks it — drawn on screen.

**[▶ Open the live demo](./index.html)**

## What you are looking at

Pick a function under test, press Run. The page fires hundreds of random inputs at it and checks a property ("sorting twice is the same as sorting once", "decode(encode(s)) equals s"). Some of the functions are genuinely, subtly buggy. When one fails, the counterexample that found it is usually large and unhelpful — a 20-element array, an odd string — so the engine automatically simplifies it, one candidate at a time, and every candidate it tried is drawn as a row and a point on a descending chart. You watch a 20-element bug become a 2-element bug.

## Why this was hard

- **Shrinking needs its own generator, not just the value.** You cannot shrink `23` into `10` without knowing it came from `int(0, 100)`, and you cannot shrink `[3, 1, 4, 1, 5]` without knowing each element came from `int()` too. The fix here is the classic one: every generator produces a `Shrinkable` — a value plus a lazy list of simpler `Shrinkable`s — so `map`, `filter`, `tuple` and `array` can all shrink their children without knowing what those children are.
- **Array shrinking is delta-debugging in miniature.** Removing one element at a time is too slow to reach a 2-element counterexample from a 40-element one in reasonable time, so the array shrinker removes chunks first (halving the removal size each pass, like a small ddmin), then falls back to shrinking individual surviving elements.
- **The bugs had to be real bugs, not straw men.** `sort()` with no comparator, an off-by-one on the binary-search loop bound, a run-length encoder that silently corrupts on runs of ten or more identical characters, and a calendar-arithmetic function that treats every non-February month as 30 days long. Each one is the kind of thing that survives a couple of manual test cases and only shows up under random pressure.
- **The shrinker is deliberately greedy and honest about it.** It takes the first simpler candidate that still fails, in generator order, rather than searching for a globally minimal counterexample — same trade-off QuickCheck and its descendants make, because a search for the true minimum does not terminate in useful time.
- **Every number on the page is measured, not written down.** The "1000 runs" benchmark and the reduction percentage both come from `pbt.js` running live in the browser (or in the tests); nothing is hardcoded.

## Run it

Open `index.html` in a browser — no build step, no dependencies, no server needed.

Tests, from the repository root:

```
node --test "projects/a4-shrink-lab/*.test.js"
```

(passing a bare directory to `--test` is rejected by Node 24 on Windows; the wildcard above works.)

The suite covers: the PRNG is deterministic for a fixed seed and differs across seeds; every generator respects its bounds; shrinking `x < 10` lands on exactly `10`; array shrinking finds a genuine 2-element counterexample; both correct subjects pass 1000 runs; every buggy subject is caught within a bounded number of runs at a fixed seed; the final counterexample on the shrink path still fails the property, and every accepted step on the path is itself a failure.

## What this is not

- **Not a replacement for fast-check or Hypothesis.** No integrated shrinking of recursive/mutually-defined generators beyond arrays, tuples and mapped values; no automatic generation from types; no `example()`/coverage guidance for the generator itself.
- **No stateful or model-based testing.** Every property here is a pure function of freshly generated arguments — there is no notion of a sequence of commands checked against a model, which is where the real value of tools like Hypothesis's stateful testing shows up.
- **Shrinking is greedy, not minimal.** It accepts the first simpler failing candidate it finds and moves on; it does not search for the smallest possible counterexample, and a different generator order can produce a different (still valid, but not necessarily smaller) minimal result.
- **The random generator is a plain SplitMix32,** not a cryptographic or statistically-rigorous PRNG. It is picked for speed and reproducibility, not distribution quality.
- **The size metric is a rough proxy** (array/string length, or a number's magnitude) used for the chart and the reduction stat, not a formal notion of counterexample complexity.
