# Taint Analyzer

A static analyzer that proves untrusted input reaches a dangerous sink — and shows the exact path it took.

**[▶ Open the live demo](./index.html)**

## What you are looking at

Paste a snippet of a small JS-like language in on the left. The tool parses
it, builds a control-flow graph, and runs a fixed-point dataflow analysis
that tracks which variables are "tainted" (derived from untrusted input like
a query parameter) as they flow through assignments, string concatenation,
branches and loops. If tainted data reaches a sink — a database query,
`eval`, `innerHTML` — without passing through a sanitizer, it is reported
with the full chain of statements the taint travelled through. The fixed-
point stepper below lets you watch the worklist algorithm converge one block
visit at a time, which is normally invisible even to people who write these
analyses for a living.

## Why this was hard

The substance is the dataflow framework, not the parser. Taint tracking is a
forward "may" analysis over the lattice `untainted ⊑ tainted`, with set
union as the join. That join is the whole precision story: at a branch
merge, if *either* predecessor leaves a variable tainted, the merged state
is tainted — which is exactly what makes "sanitized on only one branch"
still get flagged, and "sanitized on every branch" not get flagged (both are
covered by tests, `analysis.test.js`). Loops force the worklist to actually
iterate rather than settle in one pass: a block's OUT set is re-computed and
its successors re-queued only while something changed, and the queue empties
when nothing does — that's the fixed point, and the stepper exposes every
one of those visits. A second, independent analysis (reaching definitions)
runs on the exact same CFG and worklist code path, to show the framework is
generic and not taint-specific dressing.

## Run it

Open `index.html` directly, or serve the repository root with any static
file server. For the logic tests, from the repository root:

```
node --test "projects/a7-taint-analyzer/*.test.js"
```

Covers the parser, CFG shape, fixed-point termination, the taint findings
(including the two sanitizer-branch precision cases), monotonicity of the
worklist, and reaching definitions.

## Soundness vs. precision, honestly

This analysis is built **sound-leaning**: it is designed to never silently
drop a real taint flow it can see, at the cost of occasional false alarms.
Concretely:

- **Over-approximation at merges.** The join is set union, not intersection.
  A variable tainted on only one incoming branch is tainted after the merge.
  This is what catches the "sanitized on only one branch" bug, but it also
  means a variable that is tainted on a branch that can *never actually be
  taken at runtime* (a condition the analysis can't evaluate) is still
  flagged as tainted. That is a deliberate false-positive risk in exchange
  for not missing real bugs.
- **Assigning into a member expression taints the whole base object**,
  coarsely (`user.name = tainted` marks `user`, not `user.name`
  specifically). There is no field-sensitivity. This can cause both false
  positives (an untainted field looking tainted because a sibling field was
  assigned taint) and undercounting precision, but never a missed flow.
- **No aliasing.** Two variables that reference "the same" object are
  tracked independently. `let a = b; b = tainted;` does not retroactively
  taint `a` — data has to flow through an explicit assignment or expression
  for this analysis to see it. Real taint tools with alias analysis catch
  more; this one is honest that it doesn't have one.
- **Direct calls only, intraprocedural in spirit.** There is no user-defined
  function call graph — the parser accepts one top-level `function`, and
  taint through calls is handled by looking at whether a call's *arguments*
  are tainted, not by analyzing a callee's body per call site. A named
  sink/source/sanitizer list stands in for a real interprocedural summary
  algorithm.
- **No dynamic dispatch, no `eval`'d code, no arrays or objects as
  first-class values.** The parsed language deliberately has none of these
  so the analysis has no need to reason about them — a real analyzer facing
  them either treats every dynamic call as tainted (sound, very noisy) or
  gives up soundness. This one does neither, because it can't parse them at
  all; see `parse.js` for the exact subset supported.
- **String matching for sources/sinks/sanitizers** (`analysis.js`, top of
  file: `SOURCES`, `SINK_CALLS`, `SANITIZERS`). This is how essentially
  every real static taint tool works (a curated list, not magic), but it
  means renaming `escape` to `esc` silently breaks sanitization detection.

The bundled examples include one designed specifically to be a
false-positive trap (sanitized identically on every branch) — a fixed-point
analysis without a correct join could still flag it, and this one is tested
to not.

## What this is not

A production SAST tool. It has no notion of a real type system, no
inter-file analysis, no configuration for custom sources/sinks beyond
editing `analysis.js`, and the language it parses is a teaching-sized subset
of JS-like syntax, not JS itself (no arrays, objects, template literals,
`for` loops, or arrow functions). It exists to make one specific idea
legible: that "prove this bug exists" is a fixed-point computation over a
graph, and that computation is not actually mysterious once you can watch it
run.
