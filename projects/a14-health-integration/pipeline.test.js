import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MESSAGE, buildHl7Message } from "./messages.js";
import {
  STAGES,
  runPipeline,
  Ledger,
  DeadLetterQueue,
  FAULTS,
  FAULT_KEYS,
  runBatch,
  summarizeBatch,
  mulberry32,
} from "./pipeline.js";

let tick = 0;
const clock = () => tick++;

// ---------------------------------------------------------------- happy path

test("a valid message passes all seven stages and is delivered", () => {
  const outcome = runPipeline(DEFAULT_MESSAGE, { now: clock });
  assert.equal(outcome.trace.length, STAGES.length);
  assert.deepEqual(outcome.trace.map((t) => t.stage), STAGES);
  assert.ok(outcome.trace.every((t) => t.pass), "every stage should pass");
  assert.equal(outcome.terminalState, "delivered");
  assert.equal(outcome.failedStage, null);
  assert.equal(outcome.destination, "lab-system");
  assert.equal(outcome.observation.code.coding[0].display, "Glucose");
});

// ---------------------------------------------------------------- each fault fails at exactly the expected stage

test("each injected fault fails at exactly its expected stage and no earlier stage", () => {
  for (const key of FAULT_KEYS) {
    const fault = FAULTS[key];
    let outcome;
    if (fault.apply) {
      outcome = runPipeline(fault.apply(DEFAULT_MESSAGE), { now: clock });
    } else if (key === "duplicate") {
      const ledger = new Ledger();
      runPipeline(DEFAULT_MESSAGE, { ledger, now: clock });
      outcome = runPipeline(DEFAULT_MESSAGE, { ledger, now: clock });
    } else if (key === "downSystem") {
      outcome = runPipeline(DEFAULT_MESSAGE, { forceDeliverDown: true, now: clock });
    } else {
      throw new Error(`unhandled fault key ${key}`);
    }

    const failing = outcome.trace.find((t) => !t.pass);
    assert.ok(failing, `${key}: expected some stage to fail`);
    assert.equal(failing.stage, fault.expectedStage, `${key}: failed at ${failing.stage}, expected ${fault.expectedStage} (${failing.reason})`);

    // Every stage strictly before the expected one passed.
    const expectedIndex = STAGES.indexOf(fault.expectedStage);
    for (let i = 0; i < expectedIndex; i++) {
      assert.equal(outcome.trace[i].pass, true, `${key}: stage ${STAGES[i]} should have passed before ${fault.expectedStage}`);
    }
    // No stage after the failing one ran.
    assert.equal(outcome.trace.length, expectedIndex + 1, `${key}: pipeline should stop at the failing stage`);
  }
});

test("missing segment fault names the missing segment", () => {
  const outcome = runPipeline(FAULTS.missingSegment.apply(DEFAULT_MESSAGE), { now: clock });
  const failing = outcome.trace.find((t) => !t.pass);
  assert.equal(failing.field, "OBR");
  assert.match(failing.reason, /OBR/);
});

test("malformed identifier fault names the PID field", () => {
  const outcome = runPipeline(FAULTS.malformedIdentifier.apply(DEFAULT_MESSAGE), { now: clock });
  const failing = outcome.trace.find((t) => !t.pass);
  assert.equal(failing.field, "PID-3");
});

test("unknown code fault names the coding field", () => {
  const outcome = runPipeline(FAULTS.unknownCode.apply(DEFAULT_MESSAGE), { now: clock });
  const failing = outcome.trace.find((t) => !t.pass);
  assert.match(failing.reason, /ZZZ/);
});

test("value out of range fault names OBX-5", () => {
  const outcome = runPipeline(FAULTS.valueOutOfRange.apply(DEFAULT_MESSAGE), { now: clock });
  const failing = outcome.trace.find((t) => !t.pass);
  assert.equal(failing.field, "OBX-5");
});

// ---------------------------------------------------------------- idempotency

test("delivering the same control id twice is detected as a duplicate, not a second delivery", () => {
  const ledger = new Ledger();
  const first = runPipeline(DEFAULT_MESSAGE, { ledger, now: clock });
  assert.equal(first.terminalState, "delivered");
  assert.equal(ledger.deliveredCount, 1);

  const second = runPipeline(DEFAULT_MESSAGE, { ledger, now: clock });
  assert.equal(second.terminalState, "duplicate");
  assert.equal(ledger.deliveredCount, 1, "delivered count must not increment on a duplicate");
});

test("two different control ids both deliver and both count", () => {
  const ledger = new Ledger();
  runPipeline(buildHl7Message({ controlId: "MSG-A" }), { ledger, now: clock });
  runPipeline(buildHl7Message({ controlId: "MSG-B" }), { ledger, now: clock });
  assert.equal(ledger.deliveredCount, 2);
});

// ---------------------------------------------------------------- dead-letter queue

test("a rejected message can be pushed to the dead-letter queue and replayed after a fix", () => {
  const dlq = new DeadLetterQueue();
  const ledger = new Ledger();
  const broken = FAULTS.malformedIdentifier.apply(DEFAULT_MESSAGE);
  const outcome = runPipeline(broken, { ledger, now: clock });
  assert.equal(outcome.terminalState, "rejected");
  const entry = dlq.push(outcome);
  assert.equal(dlq.list().length, 1);
  assert.equal(entry.failedStage, "validate");

  const replayed = dlq.replay(entry.id, DEFAULT_MESSAGE, ledger, { now: clock });
  assert.equal(replayed.terminalState, "delivered");
  assert.equal(dlq.list().length, 0, "a successful replay must remove the entry");
});

test("replaying a dead letter with the same underlying fault leaves it queued", () => {
  const dlq = new DeadLetterQueue();
  const ledger = new Ledger();
  const broken = FAULTS.valueOutOfRange.apply(DEFAULT_MESSAGE);
  const outcome = runPipeline(broken, { ledger, now: clock });
  const entry = dlq.push(outcome);

  const stillBroken = FAULTS.valueOutOfRange.apply(DEFAULT_MESSAGE);
  const replayed = dlq.replay(entry.id, stillBroken, ledger, { now: clock });
  assert.equal(replayed.terminalState, "rejected");
  assert.equal(dlq.list().length, 1, "an unsuccessful replay must keep the entry queued");
});

// ---------------------------------------------------------------- throughput run accounting

test("mulberry32 is deterministic for a fixed seed", () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  assert.deepEqual(Array.from({ length: 10 }, () => a()), Array.from({ length: 10 }, () => b()));
});

test("a seeded batch run with a known fault mix produces exact accounting", () => {
  const faultMix = {
    valid: 5,
    missingSegment: 1,
    malformedIdentifier: 1,
    unknownCode: 1,
    valueOutOfRange: 1,
    duplicate: 1,
    downSystem: 1,
  };
  const results = runBatch(3000, faultMix, 12345, 0);
  assert.equal(results.length, 3000);

  const summary = summarizeBatch(results);
  const summedCounts = Object.values(summary).reduce((a, b) => a + b, 0);
  assert.equal(summedCounts, 3000, "every message must end in exactly one terminal state");

  // Every terminal state is one of: delivered, duplicate, or rejected-at-<stage>
  // for a stage that actually exists.
  for (const key of Object.keys(summary)) {
    if (key === "delivered" || key === "duplicate") continue;
    const stage = key.replace("rejected-at-", "");
    assert.ok(STAGES.includes(stage), `unexpected terminal key ${key}`);
  }

  // With every fault weighted into the mix, expect to see delivered messages
  // and at least one rejection at parse, validate, transform and enrich.
  assert.ok(summary.delivered > 0);
  assert.ok(summary["rejected-at-parse"] > 0);
  assert.ok(summary["rejected-at-validate"] > 0);
  assert.ok(summary["rejected-at-transform"] > 0);
  assert.ok(summary["rejected-at-enrich"] > 0);
});

test("a batch run is deterministic for a fixed seed", () => {
  const faultMix = { valid: 3, unknownCode: 1, valueOutOfRange: 1 };
  const a = summarizeBatch(runBatch(500, faultMix, 999, 0));
  const b = summarizeBatch(runBatch(500, faultMix, 999, 0));
  assert.deepEqual(a, b);
});

test("a nonzero deliver failure rate produces some rejected-at-deliver outcomes without breaking accounting", () => {
  const results = runBatch(2000, { valid: 1 }, 42, 0.5);
  const summary = summarizeBatch(results);
  const total = Object.values(summary).reduce((a, b) => a + b, 0);
  assert.equal(total, 2000);
  assert.ok(summary["rejected-at-deliver"] > 0, "expected some deliveries to fail transiently");
  assert.ok(summary.delivered > 0, "expected some deliveries to succeed");
});
