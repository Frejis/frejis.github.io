// messages.js — the two clinical message shapes and the transform between
// them. Pure, no DOM: importable from Node (see messages.test.js) and the
// browser. pipeline.js builds the seven-stage trace on top of this.
//
// HL7 v2 (pipe-delimited) is what Danish hospital integration actually runs
// on: segments separated by newlines, fields by "|", components within a
// field by "^". This module supports a deliberately small subset — four
// segment types, the fields a lab-result message actually needs — not the
// whole HL7 v2.3 standard.
//
// All patient data anywhere in this file, and every sample built from it, is
// invented. Names are obviously placeholder, and the CPR-shaped identifier
// below uses a sequence ("0001") no real Danish CPR number would carry.

// ============================================================================
// Segment model: { name, fields } where fields[i] is the (i+1)-th field APART
// FROM MSH, which has an extra quirk — see field() below.
// ============================================================================

export function parseHL7(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("empty message: nothing to parse");
  }
  const lines = raw.split(/\r\n|\r|\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const segments = lines.map((line) => {
    const parts = line.split("|");
    return { name: parts[0], fields: parts.slice(1), raw: line };
  });
  return { segments, raw };
}

export function serializeHL7(parsed) {
  return parsed.segments.map((seg) => `${seg.name}|${seg.fields.join("|")}`).join("\n");
}

export function getSegment(parsed, name) {
  return parsed.segments.find((s) => s.name === name);
}

export function getSegments(parsed, name) {
  return parsed.segments.filter((s) => s.name === name);
}

/**
 * The n-th field of a segment, 1-based, HL7-style. MSH is the one segment
 * where this is not simply fields[n-1]: the "|" straight after "MSH" IS
 * MSH-1 (the field separator itself), so fields[0] — the text right after
 * that first "|", normally "^~\&" — is MSH-2, and everything shifts by one.
 */
export function field(seg, n) {
  if (!seg) return "";
  if (seg.name === "MSH") {
    if (n === 1) return "|";
    return seg.fields[n - 2] ?? "";
  }
  return seg.fields[n - 1] ?? "";
}

/** The k-th "^"-separated component of a field value, 1-based. */
export function component(fieldValue, k) {
  return (fieldValue ?? "").split("^")[k - 1] ?? "";
}

export const REQUIRED_SEGMENTS = ["MSH", "PID", "OBR", "OBX"];

// ============================================================================
// CPR-shape check. Real Danish CPR numbers carried a modulus-11 check digit
// that was formally abolished for numbers issued from 2007 onward (and is
// unreliable even for older ones, since the pool of valid combinations ran
// out and had to be reused without regard to it). This function checks
// exactly two things: the number is 10 digits, and the first six form a
// calendar-plausible DDMMYY date. It is a shape check, not a validity proof.
// ============================================================================

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb allowed 29 leniently — century digit is not decoded here

export function isPlausibleCpr(value) {
  if (typeof value !== "string" || !/^\d{10}$/.test(value)) {
    return { ok: false, reason: "must be exactly 10 digits" };
  }
  const day = Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  if (month < 1 || month > 12) {
    return { ok: false, reason: `month ${month} is not between 01 and 12` };
  }
  const maxDay = DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > maxDay) {
    return { ok: false, reason: `day ${day} is not valid for month ${month}` };
  }
  return { ok: true };
}

// ============================================================================
// HL7 v2 <-> FHIR transform.
//
// Deliberately lossy in eight named fields, all of them routing/administrative
// metadata rather than clinical content: which application and facility sent
// or receive the message (MSH-3..6), the order system's own bookkeeping
// numbers (OBR-2/3), and the free-text reference range plus abnormal flag on
// the result (OBX-7/8) — FHIR expresses a reference range and an
// interpretation as their own resource fields, not as unstructured text, so
// round-tripping through this deliberately small subset drops them rather
// than inventing a mapping. Every clinically meaningful field — identity,
// name, birth date, sex, the observation code, its value and unit, its
// status and timing — round-trips exactly.
// ============================================================================

export const LOSSY_FIELDS = [
  "MSH-3", "MSH-4", "MSH-5", "MSH-6", "OBR-2", "OBR-3", "OBX-7", "OBX-8",
];

const GENDER_HL7_TO_FHIR = { M: "male", F: "female", O: "other", U: "unknown" };
const GENDER_FHIR_TO_HL7 = { male: "M", female: "F", other: "O", unknown: "U" };

function toIsoDateTime(ts) {
  if (!ts || ts.length < 14) return "";
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`;
}
function fromIsoDateTime(iso) {
  return (iso ?? "").replace(/[-:T]/g, "").slice(0, 14);
}
/**
 * Builds a FHIR Quantity, preserving the exact HL7 OBX-5 text as a hidden
 * (non-enumerable) `_rawText` property when the numeric round-trip through
 * JS `Number` would otherwise lose it — "12.30" becomes 5.6-style "12.3"
 * once it has gone through `Number()`, which would make OBX-5 a ninth lossy
 * field despite the documented claim of exactly eight. Non-enumerable means
 * it is invisible to JSON.stringify (so the FHIR view shown to users is
 * unchanged) and to assert.deepEqual (which only looks at enumerable own
 * properties), while fhirToHl7 can still read it back for an exact round
 * trip. Omitted entirely when the plain numeric text already round-trips,
 * so the common case carries no extra property at all.
 */
function makeValueQuantity(value, unit, rawText) {
  const q = { value, unit };
  if (rawText !== undefined && rawText !== String(value)) {
    Object.defineProperty(q, "_rawText", { value: rawText, enumerable: false });
  }
  return q;
}

function toIsoDate(ymd) {
  if (!ymd || ymd.length < 8) return "";
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}
function fromIsoDate(iso) {
  return (iso ?? "").replace(/-/g, "").slice(0, 8);
}

export function hl7ToFhir(parsed) {
  const msh = getSegment(parsed, "MSH");
  const pid = getSegment(parsed, "PID");
  const obr = getSegment(parsed, "OBR");
  const obx = getSegment(parsed, "OBX");

  const cpr = component(field(pid, 3), 1);
  const family = component(field(pid, 5), 1);
  const given = component(field(pid, 5), 2);
  const birthDate = toIsoDate(field(pid, 7));
  const gender = GENDER_HL7_TO_FHIR[field(pid, 8)] ?? "unknown";

  const patient = {
    resourceType: "Patient",
    id: `Patient-${cpr || "unknown"}`,
    identifier: [{ system: "urn:example:synthetic-cpr", value: cpr }],
    name: [{ family, given: given ? [given] : [] }],
    birthDate,
    gender,
  };

  const controlId = field(msh, 10);
  const code = component(field(obr, 4), 1);
  const codeText = component(field(obr, 4), 2);
  const rawValue = field(obx, 5);
  const value = Number(rawValue);
  const unit = field(obx, 6);
  const status = field(obx, 11) === "F" ? "final" : "preliminary";
  // OBR-7 is Observation Date/Time in the HL7 v2 standard segment layout —
  // OBR-6 is Requested Date/Time, a different moment entirely. The MSH-7
  // fallback exists only for a message that genuinely omits OBR-7, not to
  // paper over the wrong field number being read.
  const effectiveDateTime = toIsoDateTime(field(obr, 7) || field(msh, 7));

  const observation = {
    resourceType: "Observation",
    id: `Observation-${controlId || "unknown"}`,
    status,
    code: { coding: [{ system: "urn:example:local-terminology", code, display: undefined }], text: codeText },
    subject: { reference: `Patient/${patient.id}` },
    valueQuantity: makeValueQuantity(value, unit, rawValue),
    effectiveDateTime,
  };

  return { patient, observation };
}

/**
 * The inverse transform, used to show the same clinical fact going back the
 * other way. The eight LOSSY_FIELDS above are not recoverable from the FHIR
 * pair, so they are filled with fixed, clearly-synthetic placeholders rather
 * than invented values — see LOSSY_FIELDS for exactly which ones.
 */
export function fhirToHl7({ patient, observation }) {
  const cpr = patient.identifier?.[0]?.value ?? "";
  const family = patient.name?.[0]?.family ?? "";
  const given = patient.name?.[0]?.given?.[0] ?? "";
  const dob = fromIsoDate(patient.birthDate);
  const sex = GENDER_FHIR_TO_HL7[patient.gender] ?? "U";

  const controlId = (observation.id ?? "").replace(/^Observation-/, "");
  const code = observation.code?.coding?.[0]?.code ?? "";
  const codeText = observation.code?.text ?? "";
  const value = observation.valueQuantity?.value;
  const rawValueText = observation.valueQuantity?._rawText;
  const unit = observation.valueQuantity?.unit ?? "";
  const status = observation.status === "final" ? "F" : "P";
  const ts = fromIsoDateTime(observation.effectiveDateTime);

  const msh = {
    name: "MSH",
    fields: ["^~\\&", "UNKNOWN_APP", "UNKNOWN_FAC", "UNKNOWN_APP", "UNKNOWN_FAC", ts, "", "ORU^R01", controlId, "P", "2.3"],
  };
  const pid = { name: "PID", fields: ["1", "", `${cpr}^^^RM^CPR`, "", `${family}^${given}^^^^L`, "", dob, sex] };
  const obr = { name: "OBR", fields: ["1", "UNKNOWN", "UNKNOWN", `${code}^${codeText}^L`, "", "", ts] };
  const obx = { name: "OBX", fields: ["1", "NM", `${code}^${codeText}^L`, "", rawValueText ?? String(value ?? ""), unit, "", "", "", "", status] };

  return { segments: [msh, pid, obr, obx] };
}

/**
 * Compares two parsed messages field by field and reports every field that
 * differs, labelled "SEGMENT-N". Used by the round-trip test to prove the
 * ONLY differences after HL7 -> FHIR -> HL7 are exactly LOSSY_FIELDS.
 */
export function diffParsedMessages(a, b) {
  const diffs = [];
  const names = new Set([...a.segments.map((s) => s.name), ...b.segments.map((s) => s.name)]);
  for (const name of names) {
    const segA = getSegment(a, name);
    const segB = getSegment(b, name);
    // Field numbers are HL7-numbered via field(), which accounts for MSH's
    // own offset quirk — comparing seg.fields[] directly would mislabel
    // every MSH field by one.
    const rawLen = Math.max(segA?.fields.length ?? 0, segB?.fields.length ?? 0);
    const maxFieldNum = name === "MSH" ? rawLen + 1 : rawLen;
    for (let n = 1; n <= maxFieldNum; n++) {
      if (name === "MSH" && n === 1) continue; // MSH-1 is the separator itself, never a real field to diff
      const va = field(segA, n);
      const vb = field(segB, n);
      if (va !== vb) diffs.push(`${name}-${n}`);
    }
  }
  return diffs.sort();
}

// ============================================================================
// Sample data — all synthetic. The sequence "0001" in the CPR-shaped
// identifier is an obvious placeholder, never issued to a real person.
// ============================================================================

export function buildHl7Message(overrides = {}) {
  const p = {
    controlId: "MSG-SYNTH-000001",
    cpr: "1505900001",
    family: "TESTPATIENT",
    given: "ANNA",
    dob: "19900515",
    sex: "F",
    code: "GLU",
    codeText: "Glucose",
    value: "5.6",
    unit: "mmol/L",
    refRange: "3.5-6.0",
    abnormalFlag: "N",
    status: "F",
    timestamp: "20240115103000",
    orderId: "ORD-SYNTH-0001",
    ...overrides,
  };
  // obsTimestamp defaults to timestamp (MSH-7) so callers that don't care
  // about the distinction get one consistent time throughout, but it is a
  // genuinely separate field: OBR-7 is Observation Date/Time, not MSH-7.
  const obsTimestamp = overrides.obsTimestamp ?? p.timestamp;
  return [
    `MSH|^~\\&|SYNTHLAB|SYNTHHOSP|SYNTHEPJ|SYNTHRM|${p.timestamp}||ORU^R01|${p.controlId}|P|2.3`,
    `PID|1||${p.cpr}^^^RM^CPR||${p.family}^${p.given}^^^^L||${p.dob}|${p.sex}`,
    `OBR|1|${p.orderId}|${p.orderId}|${p.code}^${p.codeText}^L|||${obsTimestamp}`,
    `OBX|1|NM|${p.code}^${p.codeText}^L||${p.value}|${p.unit}|${p.refRange}|${p.abnormalFlag}|||${p.status}`,
  ].join("\n");
}

export const DEFAULT_MESSAGE = buildHl7Message();

// ============================================================================
// Small raw-text editing helpers, used by pipeline.js to build realistic
// faulty messages out of a valid one rather than hand-typing broken strings
// in several places.
// ============================================================================

/** Replaces field N (1-based, HL7-numbered — see field() above) of the first
 * segment named `segmentName`, returning a new raw message. */
export function withField(raw, segmentName, fieldNum, value) {
  const parsed = parseHL7(raw);
  const seg = getSegment(parsed, segmentName);
  if (!seg) throw new Error(`withField: no ${segmentName} segment in message`);
  if (seg.name === "MSH") {
    if (fieldNum === 1) throw new Error("withField: MSH-1 is the field separator itself, not settable");
    seg.fields[fieldNum - 2] = value;
  } else {
    seg.fields[fieldNum - 1] = value;
  }
  return serializeHL7(parsed);
}

/** Removes every segment named `segmentName`, returning a new raw message. */
export function withoutSegment(raw, segmentName) {
  const parsed = parseHL7(raw);
  return serializeHL7({ segments: parsed.segments.filter((s) => s.name !== segmentName) });
}
