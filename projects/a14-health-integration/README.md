# Integration Trace

A health-message pipeline you can break and debug: a lab result moves
through seven stages between hospital systems, and when it fails you can see
exactly which one rejected it and why.

**[▶ Open the live demo](./index.html)**

## What you are looking at

A clinical message — patient, an ordered test, a result — modelled on the
formats Danish hospital integration actually runs on: HL7 v2's pipe-delimited
segments, and the FHIR JSON resources many systems are moving towards. It
flows through seven stages (receive, parse, validate, transform, enrich,
route, deliver), each of which can pass or reject with a precise reason. The
trace strip at the top draws that journey as boxes that turn green, red or
stay grey; click any box to see what it checked. Six fault buttons inject
realistic, specific problems — a missing segment, a malformed patient
identifier, an unknown lab code, an implausible result value, a duplicate
message, a downstream system that is down — and each one fails at a
different stage, so the trace lights up somewhere new every time. Rejected
messages queue in a dead-letter panel and can be edited and replayed. A
throughput run pushes thousands of messages through at once with a
configurable fault mix and charts exactly how many arrived and where the
rest died.

## Why this was hard

The honest difficulty was not the parsing — pipe-delimited text is simple —
it was making the SAME six-line change to a message reliably land on ONE
named stage and no other, so the trace view can be trusted rather than just
decorative. `pipeline.test.js`'s "each injected fault fails at exactly its
expected stage and no earlier stage" test is the one that actually proves
this: it asserts every stage before the expected one passed, and that
nothing after the failing stage ran at all. Getting there meant deliberately
choosing which stage owns which check — the value-range check lives in
`transform` (checking the number just before it becomes a FHIR
`valueQuantity`) rather than in `validate` alongside the identifier check,
purely so `valueOutOfRange` and `malformedIdentifier` do not collide on the
same box. That is a real trade-off a real integration engineer would also
face — where exactly does "this number came in as text but should have been
a number" belong versus "this number is not physiologically plausible" — and
`pipeline.js` says so in a comment rather than pretending there was only one
right answer.

The other real decision was idempotency. Almost every toy integration demo
skips it, and it is the single property that actually matters in production
message routing (Apache Camel calls the pattern the Idempotent Consumer EIP
for a reason): the same control id delivered twice must be detected and must
not be delivered — or counted — twice. The ledger here is a plain `Map`, but
the guarantee it gives is exact, and `pipeline.test.js` checks the delivered
count directly rather than trusting that "duplicate" showing up in a log
somewhere means it worked.

## Run it

Open `index.html` in a browser — no build step, no dependencies, no server
required.

Tests, from the repository root:

```
node --test "projects/a14-health-integration/*.test.js"
```

(passing a bare directory to `--test` is rejected by Node 24 on Windows; the
wildcard above works, but only quoted — cmd.exe expands an unquoted `*`
itself and hands node a `MODULE_NOT_FOUND` instead of a glob.)

They cover: HL7 v2 parsing and serialising round-tripping a realistic
multi-segment message exactly; a message missing a required segment failing
at the parse stage with the segment named; the HL7-to-FHIR transform
producing the expected `Patient`/`Observation` shape, with a round-trip test
that asserts the ONLY fields that differ afterwards are the documented lossy
ones; every one of the six injected faults failing at exactly its expected
stage; a valid message passing all seven; idempotent delivery (a repeated
control id is detected and the delivered count does not double-count); a
dead-letter replay of a corrected message succeeding, and a replay that
repeats the same mistake staying queued; and a seeded batch run producing
exact accounting — every message in exactly one terminal state, the counts
summing to the total.

### The HL7 v2 subset

Four segment types: `MSH` (header), `PID` (patient), `OBR` (order), `OBX`
(observation/result) — enough to carry one lab result end to end, not the
whole HL7 v2.3 message catalogue. `MSH` has a well-known quirk this code
handles explicitly: the `|` immediately after `MSH` IS field 1 (the field
separator character itself), so everything else in the segment is shifted by
one relative to every other segment type — `field()` in `messages.js`
accounts for this rather than making every caller remember it.

### What the HL7 ↔ FHIR transform deliberately loses

Eight fields, all routing/administrative metadata, never clinical content:
which application and facility sent or received the message (`MSH-3..6`),
the order system's own bookkeeping numbers (`OBR-2/3`), and the free-text
reference range plus abnormal flag on the result (`OBX-7/8`) — FHIR expresses
a reference range and an interpretation as their own structured resource
fields, not as unstructured text, so this deliberately small subset drops
them rather than inventing a mapping that does not exist in the standard.
Every clinically meaningful field — patient identity, name, birth date, sex,
the observation code, its value and unit, its status, its timing — round-trips
exactly, and `messages.test.js` proves it by diffing the original message
against a full HL7 → FHIR → HL7 round trip and asserting the diff is exactly
these eight fields, not "close".

### How the CPR check is modelled

The identifier check requires exactly 10 digits with a calendar-plausible
`DDMMYY` date in the first six. Real Danish CPR numbers historically carried
a modulus-11 check digit; that rule was formally abolished for numbers issued
from 2007 onward (and had already become unreliable before that, once the
pool of valid combinations under it ran out and had to be reused without
regard to it). This demo therefore only checks *shape* — ten digits, a date
that could exist — not validity, and the page says so next to the editor
rather than only in this README.

## What this is not

- **Not a real integration platform.** There is no Apache Camel, no message
  broker or queueing middleware, no persistence beyond an in-memory `Map` and
  array that reset on reload, and no security or consent model — a real
  clinical integration handles authentication, audit logging and
  patient-consent rules that this demo does not touch at all.
- **The HL7 v2 and FHIR support is a deliberately small subset**: four
  segment types, one resource pair (`Patient` + `Observation`), a handful of
  fields on each. Real HL7 v2 interfaces carry dozens of segment and message
  types; real FHIR servers implement dozens of resource types with full
  terminology binding.
- **All patient data is synthetic.** Every name, "CPR" number and result
  value in this project is invented for the demo; the CPR-shaped identifiers
  use an obvious placeholder sequence, never a real allocation.
- **No real registry, terminology server or downstream system is contacted.**
  The terminology table, the routing table and the "downstream system" in
  the deliver stage are small hand-written objects in `pipeline.js`, not
  connections to MidtEPJ, a national registry, or anything else real.
- **The throughput run is a demonstration of accounting logic, not a load
  test.** It measures how fast this pipeline's pure JavaScript logic runs in
  one browser tab with no I/O; it says nothing about what a real integration
  engine moving 80,000 messages a day across real networks and real systems
  can sustain.
