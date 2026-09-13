// pipeline.js — the seven-stage message pipeline. Pure, no DOM: importable
// from Node (see pipeline.test.js) and the browser.
//
// A message moves through receive -> parse -> validate -> transform ->
// enrich -> route -> deliver. Each stage returns a structured result (pass,
// reason, the field or segment at fault, a timestamp) and the pipeline stops
// at the first rejection — a rejected message never reaches later stages,
// which is exactly what the trace view needs to draw grey boxes truthfully.
//
// STAGE ASSIGNMENT NOTE: a real reading of "validate" would put both the
// patient-identifier check and the value-range check in the same stage, and
// a real reading of "deliver" would put both an idempotency check and a
// down-system check there too. For this demo every one of the six injected
// faults needs to light up a DIFFERENT box in the trace view, so the range
// check lives in transform (checking the number that is about to become a
// FHIR valueQuantity) and the duplicate-control-id check lives in route (an
// idempotent-consumer check ahead of the actual send, in the spirit of
// Apache Camel's Idempotent Consumer EIP). Both placements are realistic
// engineering choices, just not the only ones a real system would make.

import { parseHL7, getSegment, field, component, isPlausibleCpr, hl7ToFhir, REQUIRED_SEGMENTS } from "./messages.js";

export const STAGES = ["receive", "parse", "validate", "transform", "enrich", "route", "deliver"];

// ============================================================================
// Local terminology and routing tables — small, hand-maintained, exactly the
// kind of "supplier sets up their own codes, someone has to keep a mapping
// table current" problem the posting describes.
// ============================================================================

export const TERMINOLOGY = {
  GLU: { display: "Glucose" },
  HGB: { display: "Haemoglobin" },
  NA: { display: "Sodium" },
  K: { display: "Potassium" },
  CREA: { display: "Creatinine" },
};

// Physiologically plausible ranges, used by the transform stage to catch a
// value that could never be real before it becomes a FHIR quantity. Codes
// absent here are not range-checked at this stage — an unrecognised code is
// the enrich stage's problem, not transform's.
export const VALUE_RANGES = {
  GLU: { min: 1, max: 40, unit: "mmol/L" },
  HGB: { min: 2, max: 12, unit: "mmol/L" },
  NA: { min: 100, max: 180, unit: "mmol/L" },
  K: { min: 1, max: 9, unit: "mmol/L" },
  CREA: { min: 10, max: 1500, unit: "umol/L" },
};

export const ROUTES = {
  GLU: "lab-system", HGB: "lab-system", NA: "lab-system", K: "lab-system", CREA: "lab-system",
};
export const DEFAULT_ROUTE = "general-registry";

const ALLOWED_CODE_PATTERN = /^[A-Z0-9]{1,8}$/;

// ============================================================================
// Idempotency ledger — the single most important property in real message
// integration and the easiest to skip in a demo. Keyed by MSH-10 (control
// id). A control id already marked delivered must not be delivered again.
// ============================================================================

export class Ledger {
  constructor() {
    this.delivered = new Map(); // controlId -> { destination, at }
  }
  hasDelivered(controlId) {
    return this.delivered.has(controlId);
  }
  markDelivered(controlId, info) {
    this.delivered.set(controlId, info);
  }
  get deliveredCount() {
    return this.delivered.size;
  }
}

// ============================================================================
// mulberry32 — small seedable PRNG, used only for the throughput run so a
// fault mix and a delivery failure rate are reproducible at a fixed seed.
// ============================================================================

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// The seven stages.
// ============================================================================

function stageResult(stage, pass, reason, atField, timestamp) {
  return { stage, pass, reason: reason ?? null, field: atField ?? null, timestamp };
}

function doReceive(raw, now) {
  return { result: stageResult("receive", true, "message arrived", null, now()), data: { raw } };
}

function doParse(raw, now) {
  let parsed;
  try {
    parsed = parseHL7(raw);
  } catch (err) {
    return { result: stageResult("parse", false, err.message, null, now()), data: null };
  }
  for (const name of REQUIRED_SEGMENTS) {
    if (!getSegment(parsed, name)) {
      return {
        result: stageResult("parse", false, `missing required segment: ${name}`, name, now()),
        data: null,
      };
    }
  }
  const minFields = { MSH: 9, PID: 7, OBR: 4, OBX: 5 };
  for (const [name, min] of Object.entries(minFields)) {
    const seg = getSegment(parsed, name);
    // MSH's field array excludes MSH-1 (the separator), so it is one short
    // of the raw field count everywhere else — see field() in messages.js.
    const have = name === "MSH" ? seg.fields.length + 1 : seg.fields.length;
    if (have < min) {
      return {
        result: stageResult("parse", false, `${name} has too few fields (need at least ${min}, has ${have})`, name, now()),
        data: null,
      };
    }
  }
  return { result: stageResult("parse", true, "structurally valid", null, now()), data: { parsed } };
}

function doValidate(parsed, now) {
  const pid = getSegment(parsed, "PID");
  const cpr = component(field(pid, 3), 1);
  const cprCheck = isPlausibleCpr(cpr);
  if (!cprCheck.ok) {
    return {
      result: stageResult("validate", false, `patient identifier "${cpr}" is malformed: ${cprCheck.reason}`, "PID-3", now()),
      data: null,
    };
  }

  const obr = getSegment(parsed, "OBR");
  const code = component(field(obr, 4), 1);
  if (!ALLOWED_CODE_PATTERN.test(code)) {
    return {
      result: stageResult("validate", false, `observation code "${code}" is not a well-formed code (expected 1-8 upper-case letters or digits)`, "OBR-4", now()),
      data: null,
    };
  }

  const obx = getSegment(parsed, "OBX");
  const rawValue = field(obx, 5);
  const value = Number(rawValue);
  if (rawValue === "" || !Number.isFinite(value)) {
    return {
      result: stageResult("validate", false, `observation value "${rawValue}" is not a number`, "OBX-5", now()),
      data: null,
    };
  }

  return { result: stageResult("validate", true, "required fields present and well-formed", null, now()), data: { parsed } };
}

function doTransform(parsed, valueRanges, now) {
  const obr = getSegment(parsed, "OBR");
  const obx = getSegment(parsed, "OBX");
  const code = component(field(obr, 4), 1);
  const value = Number(field(obx, 5));
  const range = valueRanges[code];
  if (range && (value < range.min || value > range.max)) {
    return {
      result: stageResult(
        "transform",
        false,
        `value ${value} ${range.unit} is outside the plausible range for ${code} (${range.min}-${range.max} ${range.unit})`,
        "OBX-5",
        now()
      ),
      data: null,
    };
  }
  let fhir;
  try {
    fhir = hl7ToFhir(parsed);
  } catch (err) {
    return { result: stageResult("transform", false, `could not build FHIR resources: ${err.message}`, null, now()), data: null };
  }
  return { result: stageResult("transform", true, "HL7 v2 converted to FHIR Patient + Observation", null, now()), data: { fhir } };
}

function doEnrich(fhir, terminology, now) {
  const coding = fhir.observation.code.coding[0];
  const entry = terminology[coding.code];
  if (!entry) {
    return {
      result: stageResult(
        "enrich",
        false,
        `unknown observation code "${coding.code}": not present in the local terminology table`,
        "Observation.code.coding[0].code",
        now()
      ),
      data: null,
    };
  }
  coding.display = entry.display;
  return { result: stageResult("enrich", true, `resolved to "${entry.display}"`, null, now()), data: { fhir } };
}

function doRoute(parsed, fhir, ledger, now) {
  const controlId = field(getSegment(parsed, "MSH"), 10);
  if (ledger.hasDelivered(controlId)) {
    const prior = ledger.delivered.get(controlId);
    return {
      result: stageResult(
        "route",
        false,
        `duplicate control id "${controlId}": already delivered to ${prior.destination}`,
        "MSH-10",
        now()
      ),
      data: null,
    };
  }
  const code = fhir.observation.code.coding[0].code;
  const destination = ROUTES[code] ?? DEFAULT_ROUTE;
  return { result: stageResult("route", true, `routed to ${destination}`, null, now()), data: { destination, controlId } };
}

function doDeliver(destination, controlId, ledger, { forceDown, failureRate, rng }, now) {
  if (forceDown) {
    return { result: stageResult("deliver", false, `downstream system "${destination}" is down`, null, now()), data: null };
  }
  if (failureRate > 0 && rng && rng() < failureRate) {
    return { result: stageResult("deliver", false, `delivery to "${destination}" failed: transient error`, null, now()), data: null };
  }
  const at = now();
  ledger.markDelivered(controlId, { destination, at });
  return { result: stageResult("deliver", true, `delivered to ${destination}`, null, at) };
}

// ============================================================================
// runPipeline — drives one message through all seven stages.
// ============================================================================

/**
 * @param {string} raw - the raw HL7 v2 text
 * @param {object} opts
 * @param {Ledger} [opts.ledger] - shared idempotency ledger; a fresh one is
 *   created per call if omitted, which means duplicate detection only works
 *   across calls that pass the SAME ledger instance.
 * @param {object} [opts.terminology] - defaults to TERMINOLOGY
 * @param {object} [opts.valueRanges] - defaults to VALUE_RANGES
 * @param {boolean} [opts.forceDeliverDown] - simulates the "downstream
 *   system down" fault regardless of destination
 * @param {number} [opts.failureRate] - random transient delivery failure
 *   probability, used by the throughput run
 * @param {function} [opts.rng] - 0..1 generator backing failureRate
 * @param {function} [opts.now] - clock, defaults to Date.now; pipeline.test.js
 *   passes a fixed counter so trace timestamps are comparable in assertions
 */
export function runPipeline(raw, opts = {}) {
  const {
    ledger = new Ledger(),
    terminology = TERMINOLOGY,
    valueRanges = VALUE_RANGES,
    forceDeliverDown = false,
    failureRate = 0,
    rng = null,
    now = () => Date.now(),
  } = opts;

  const trace = [];
  let parsed = null, fhir = null, destination = null, controlId = null;

  const receive = doReceive(raw, now);
  trace.push(receive.result);

  const parseStep = doParse(raw, now);
  trace.push(parseStep.result);
  if (!parseStep.result.pass) return finish();
  parsed = parseStep.data.parsed;

  const validateStep = doValidate(parsed, now);
  trace.push(validateStep.result);
  if (!validateStep.result.pass) return finish();

  const transformStep = doTransform(parsed, valueRanges, now);
  trace.push(transformStep.result);
  if (!transformStep.result.pass) return finish();
  fhir = transformStep.data.fhir;

  const enrichStep = doEnrich(fhir, terminology, now);
  trace.push(enrichStep.result);
  if (!enrichStep.result.pass) return finish();
  fhir = enrichStep.data.fhir;

  const routeStep = doRoute(parsed, fhir, ledger, now);
  trace.push(routeStep.result);
  if (!routeStep.result.pass) return finish();
  ({ destination, controlId } = routeStep.data);

  const deliverStep = doDeliver(destination, controlId, ledger, { forceDown: forceDeliverDown, failureRate, rng }, now);
  trace.push(deliverStep.result);
  return finish();

  function finish() {
    const last = trace[trace.length - 1];
    let terminalState;
    if (last.pass && last.stage === "deliver") terminalState = "delivered";
    else if (last.stage === "route" && !last.pass && /duplicate control id/.test(last.reason)) terminalState = "duplicate";
    else terminalState = "rejected";
    return {
      raw,
      trace,
      terminalState,
      failedStage: terminalState === "rejected" || terminalState === "duplicate" ? last.stage : null,
      parsed,
      patient: fhir?.patient ?? null,
      observation: fhir?.observation ?? null,
      destination,
      controlId: controlId ?? (parsed ? field(getSegment(parsed, "MSH"), 10) : null),
    };
  }
}

// ============================================================================
// Dead-letter queue — rejected messages, replayable after a fix. Duplicates
// are not dead-lettered: re-sending an already-delivered message succeeding
// silently is the correct behaviour, not a failure to fix.
// ============================================================================

export class DeadLetterQueue {
  constructor() {
    this.entries = [];
    this._nextId = 1;
  }
  push(outcome) {
    const entry = { id: this._nextId++, raw: outcome.raw, trace: outcome.trace, failedStage: outcome.failedStage };
    this.entries.push(entry);
    return entry;
  }
  remove(id) {
    this.entries = this.entries.filter((e) => e.id !== id);
  }
  list() {
    return this.entries;
  }
  /** Replays a corrected raw message through the pipeline; removes the
   * dead-letter entry on success, leaves it queued on renewed failure. */
  replay(id, correctedRaw, ledger, opts = {}) {
    const outcome = runPipeline(correctedRaw, { ...opts, ledger });
    if (outcome.terminalState === "delivered") {
      this.remove(id);
    }
    return outcome;
  }
}

// ============================================================================
// Faults — each mutates a valid raw message so it fails at exactly one
// named stage. "duplicate" and "downSystem" are not raw mutations (a
// duplicate is only a duplicate in the context of a ledger that has already
// seen it, and a down system is a delivery-time condition) so they are
// applied by the caller via runPipeline's forceDeliverDown option and by
// resending an already-delivered raw message, respectively — see
// FAULT_KEYS for the full set used by the throughput run and the UI.
// ============================================================================

export const FAULTS = {
  missingSegment: {
    label: "Missing required segment",
    expectedStage: "parse",
    apply: (raw) => raw.split(/\r\n|\r|\n/).filter((l) => !l.startsWith("OBR|")).join("\n"),
  },
  malformedIdentifier: {
    label: "Malformed patient identifier",
    expectedStage: "validate",
    apply: (raw) => setField(raw, "PID", 3, "12345^^^RM^CPR"),
  },
  unknownCode: {
    label: "Unknown observation code",
    expectedStage: "enrich",
    apply: (raw) => setField(setField(raw, "OBR", 4, "ZZZ^Unmapped test^L"), "OBX", 3, "ZZZ^Unmapped test^L"),
  },
  valueOutOfRange: {
    label: "Value out of range",
    expectedStage: "transform",
    apply: (raw) => setField(raw, "OBX", 5, "999"),
  },
  // These two are not raw-text mutations — a duplicate is only a duplicate
  // in the context of a ledger that already delivered this control id, and
  // a down system is a delivery-time condition — so apply is null and the
  // caller (runBatch, or app.js) supplies the effect via runPipeline's own
  // forceDeliverDown option or by resending an already-delivered message.
  duplicate: {
    label: "Duplicate control id (already delivered)",
    expectedStage: "route",
    apply: null,
  },
  downSystem: {
    label: "Downstream system is down",
    expectedStage: "deliver",
    apply: null,
  },
};

export const FAULT_KEYS = ["missingSegment", "malformedIdentifier", "unknownCode", "valueOutOfRange", "duplicate", "downSystem"];

// A tiny local field-setter kept in pipeline.js (rather than importing
// withField from messages.js) so FAULTS.apply never depends on parse having
// already succeeded — missingSegment in particular must produce text that
// fails to parse structurally, not text messages.js's own parser rejects.
function setField(raw, segmentName, fieldNum, value) {
  const lines = raw.split(/\r\n|\r|\n/);
  const idx = lines.findIndex((l) => l.startsWith(segmentName + "|"));
  if (idx === -1) return raw;
  const parts = lines[idx].split("|");
  if (segmentName === "MSH") parts[fieldNum - 1] = value;
  else parts[fieldNum] = value;
  lines[idx] = parts.join("|");
  return lines.join("\n");
}

// ============================================================================
// Throughput run — pushes many messages through the pipeline with a
// configurable fault mix and a shared ledger, and returns exact accounting.
// ============================================================================

/**
 * @param {number} count
 * @param {object} faultMix - weights keyed by "valid" or a FAULT_KEYS entry;
 *   need not sum to 1, they are normalised.
 * @param {number} seed
 * @param {number} [deliverFailureRate] - independent transient failure rate
 *   applied at the deliver stage of every message that reaches it
 */
export function runBatch(count, faultMix, seed, deliverFailureRate = 0) {
  const rng = mulberry32(seed);
  const ledger = new Ledger();
  const keys = Object.keys(faultMix).filter((k) => faultMix[k] > 0);
  const totalWeight = keys.reduce((s, k) => s + faultMix[k], 0) || 1;
  let lastDelivered = null; // { controlId, raw }
  const results = [];
  let tick = 0;
  const clock = () => tick++;

  for (let i = 0; i < count; i++) {
    const r = rng() * totalWeight;
    let acc = 0, chosen = "valid";
    for (const k of keys) {
      acc += faultMix[k];
      if (r < acc) { chosen = k; break; }
    }

    let raw;
    const pipelineOpts = { ledger, now: clock, failureRate: deliverFailureRate, rng };
    if (chosen === "duplicate" && lastDelivered) {
      raw = lastDelivered.raw;
    } else {
      const controlId = `MSG-${String(i).padStart(6, "0")}`;
      raw = buildDefaultRaw(controlId);
      const fault = FAULTS[chosen];
      if (fault && fault.apply) raw = fault.apply(raw);
      if (chosen === "downSystem") pipelineOpts.forceDeliverDown = true;
    }

    const outcome = runPipeline(raw, pipelineOpts);
    if (outcome.terminalState === "delivered") lastDelivered = { controlId: outcome.controlId, raw };
    results.push(outcome);
  }
  return results;
}

// Kept tiny and local (rather than importing buildHl7Message from
// messages.js) purely to avoid a second control-id convention living in two
// files; the format matches messages.js's DEFAULT_MESSAGE exactly.
function buildDefaultRaw(controlId) {
  return [
    `MSH|^~\\&|SYNTHLAB|SYNTHHOSP|SYNTHEPJ|SYNTHRM|20240115103000||ORU^R01|${controlId}|P|2.3`,
    "PID|1||1505900001^^^RM^CPR||TESTPATIENT^ANNA^^^^L||19900515|F",
    "OBR|1|ORD-SYNTH-0001|ORD-SYNTH-0001|GLU^Glucose^L|||20240115103000",
    "OBX|1|NM|GLU^Glucose^L||5.6|mmol/L|3.5-6.0|N|||F",
  ].join("\n");
}

/** Tallies outcomes into a total that always sums exactly: "delivered",
 * "duplicate", or "rejected-at-<stage>" for every rejection stage seen. */
export function summarizeBatch(results) {
  const counts = {};
  for (const r of results) {
    const key = r.terminalState === "rejected" ? `rejected-at-${r.failedStage}` : r.terminalState;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
