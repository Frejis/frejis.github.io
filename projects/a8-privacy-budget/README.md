# Privacy Budget

A health registry you can query for real answers, where the mathematics
guarantees you never learn anything about any one person — and a button that
turns the guarantee off so you can watch a single individual's diagnosis fall
out of two innocent aggregate queries.

**[▶ Open the live demo](./index.html)**

## What you are looking at

2 000 synthetic Danes with an age, a region, an income and a chronic diagnosis.
You ask aggregate questions — how many people have the diagnosis in
Midtjylland, what is the average income in Nordjylland — and get an answer that
has been deliberately blurred by a measured amount of random noise. A budget
bar at the top drains with every query, because the guarantee is about the
whole sequence of questions, not any single one. When it is empty the database
stops answering, and that refusal is the point of the whole design.

The page shows the true answer next to the noisy one. A real deployment never
does that. This one does because it is a teaching tool and the gap between the
two columns is what there is to learn.

## Why this was hard

The mathematics is short; getting the sensitivity right is the whole job.
A count moves by 1 when one person joins, so noise of scale 1/ε is enough. A
sum over incomes has *no finite sensitivity at all* until you clamp the range,
because one person with an unbounded income moves it arbitrarily far — the
clamp is not tidying, it is what makes the query answerable, and the page says
so when it bites. A mean is two releases, so it splits its ε between the noisy
sum and the noisy count. A histogram over disjoint regions is charged once, not
once per bar, because a person sits in exactly one bin (parallel composition).
Get any of those wrong and you have a page that looks identical and guarantees
nothing.

## Run it

Open `index.html` in any modern browser, from disk or from a static server.
No build, no dependencies, no network.

Tests:

```
node --test "projects/a8-privacy-budget/*.test.js"
```

The suite covers: the seeded generator is byte-identical across runs,
Laplace samples hit mean 0 and variance 2b² over 200 000 draws, sensitivities
are checked against clamp bounds, an outlier's contribution to a clamped sum is
proved to stay under the declared sensitivity, sequential composition sums and
parallel composition maxes, the budget refuses the query that would overrun it
without recording the spend, and the differencing attack is verified both ways
— exact with noise off, and back down to 48–52% (a coin flip) at ε = 0.05 over
1 500 seeded trials.

## Reading the four charts

- **Distribution of noisy answers.** Drag epsilon and 2 000 simulated releases
  of the same query redraw around the truth. This one picture is the entire
  accuracy/privacy trade-off.
- **Attack success rate against ε.** 500 differencing attacks at each of ten
  epsilon values, measured live. It starts at certainty and collapses onto the
  50% line where the attacker has learned nothing.
- **Error against ε.** Mean absolute error over 300 runs per epsilon, with the
  theoretical E|Laplace(0, b)| = Δ/ε overlaid. Both lines are computed in the
  page; nothing is hardcoded.
- **Income by region under DP.** The reason any of this exists: at sensible
  epsilon the finding survives the noise, and an analyst can still work.

## What this is not

- **The data is synthetic.** 2 000 fictional records generated from a fixed
  seed in `data.js`. No real person, Danish or otherwise, is in this page. The
  regions are real administrative units; every number attached to them is
  invented.
- **No secure aggregation and no trusted-curator problem is solved.** This is
  the central model: the code holds the raw records in memory and adds noise on
  output. A real deployment has to decide who is allowed to hold that data, and
  that question is harder than the mathematics here.
- **The Laplace implementation is the naive one.** Sampling by inverse
  transform on 64-bit floats leaks through the gaps in the floating-point
  representation — Mironov's 2012 result on this is real and known, and
  production mechanisms use the discrete Laplace/snapping variants instead.
  This one is written for legibility.
- **The accounting is basic composition only.** Epsilons are added
  sequentially and maxed over disjoint groups. No advanced composition, no
  Rényi or zCDP accountant, no privacy amplification by subsampling, so the
  budget spends faster than a serious deployment would need to.
- **The true answer is on screen.** Deliberately, and only because this is a
  teaching tool. Shipping that column would defeat the entire mechanism.
- **The Gaussian mechanism uses the classical (ε, δ) analysis**, which is
  valid for ε ≤ 1 and merely conservative above it. The slider goes to 5.
- **A single attack run proves nothing either way.** The chart exists because
  the honest claim is about the distribution over many attempts, not about
  whether the attacker guessed right once.
