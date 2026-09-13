import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHL7,
  serializeHL7,
  getSegment,
  field,
  component,
  isPlausibleCpr,
  hl7ToFhir,
  fhirToHl7,
  diffParsedMessages,
  buildHl7Message,
  DEFAULT_MESSAGE,
  LOSSY_FIELDS,
  withField,
  withoutSegment,
} from "./messages.js";

// ---------------------------------------------------------------- HL7 parse/serialise

test("HL7 v2 round-trips a realistic multi-segment message exactly", () => {
  const raw = DEFAULT_MESSAGE;
  const parsed = parseHL7(raw);
  assert.equal(parsed.segments.length, 4);
  assert.deepEqual(parsed.segments.map((s) => s.name), ["MSH", "PID", "OBR", "OBX"]);
  assert.equal(serializeHL7(parsed), raw);
});

test("field() reads MSH fields correctly despite the MSH-1 offset quirk", () => {
  const parsed = parseHL7(DEFAULT_MESSAGE);
  const msh = getSegment(parsed, "MSH");
  assert.equal(field(msh, 1), "|");
  assert.equal(field(msh, 2), "^~\\&");
  assert.equal(field(msh, 3), "SYNTHLAB");
  assert.equal(field(msh, 9), "ORU^R01");
  assert.equal(field(msh, 10), "MSG-SYNTH-000001");
});

test("field() reads non-MSH fields directly and component() splits on caret", () => {
  const parsed = parseHL7(DEFAULT_MESSAGE);
  const pid = getSegment(parsed, "PID");
  assert.equal(field(pid, 3), "1505900001^^^RM^CPR");
  assert.equal(component(field(pid, 3), 1), "1505900001");
  assert.equal(component(field(pid, 5), 1), "TESTPATIENT");
  assert.equal(component(field(pid, 5), 2), "ANNA");
});

test("parsing an empty message throws rather than returning something silently wrong", () => {
  assert.throws(() => parseHL7(""), /empty message/);
  assert.throws(() => parseHL7("   \n\n "), /empty message/);
});

// ---------------------------------------------------------------- CPR shape check

test("isPlausibleCpr accepts a 10-digit number with a calendar-valid date part", () => {
  assert.equal(isPlausibleCpr("1505900001").ok, true);
  assert.equal(isPlausibleCpr("0101000001").ok, true); // 1 Jan
  assert.equal(isPlausibleCpr("2902000001").ok, true); // 29 Feb, leniently allowed
});

test("isPlausibleCpr rejects the wrong length, non-digits, and an impossible date", () => {
  assert.equal(isPlausibleCpr("12345").ok, false);
  assert.equal(isPlausibleCpr("150590000A").ok, false);
  assert.equal(isPlausibleCpr("3213900001").ok, false); // month 13
  assert.equal(isPlausibleCpr("3202900001").ok, false); // 32nd of Feb
  assert.equal(isPlausibleCpr(undefined).ok, false);
});

// ---------------------------------------------------------------- HL7 -> FHIR transform

test("hl7ToFhir produces the expected Patient and Observation resource shape", () => {
  const parsed = parseHL7(DEFAULT_MESSAGE);
  const { patient, observation } = hl7ToFhir(parsed);

  assert.equal(patient.resourceType, "Patient");
  assert.deepEqual(patient.identifier, [{ system: "urn:example:synthetic-cpr", value: "1505900001" }]);
  assert.deepEqual(patient.name, [{ family: "TESTPATIENT", given: ["ANNA"] }]);
  assert.equal(patient.birthDate, "1990-05-15");
  assert.equal(patient.gender, "female");

  assert.equal(observation.resourceType, "Observation");
  assert.equal(observation.status, "final");
  assert.equal(observation.code.coding[0].code, "GLU");
  assert.equal(observation.code.text, "Glucose");
  assert.equal(observation.subject.reference, `Patient/${patient.id}`);
  assert.deepEqual(observation.valueQuantity, { value: 5.6, unit: "mmol/L" });
  assert.equal(observation.effectiveDateTime, "2024-01-15T10:30:00");
});

test("HL7 -> FHIR -> HL7 round-trip differs from the original in exactly the documented lossy fields", () => {
  const parsed = parseHL7(DEFAULT_MESSAGE);
  const fhir = hl7ToFhir(parsed);
  const back = fhirToHl7(fhir);
  const diffs = diffParsedMessages(parsed, back);
  assert.deepEqual(diffs, [...LOSSY_FIELDS].sort());
});

test("HL7 -> FHIR -> HL7 round-trip preserves every clinically meaningful field", () => {
  const parsed = parseHL7(DEFAULT_MESSAGE);
  const back = fhirToHl7(hl7ToFhir(parsed));
  const pidBack = getSegment(back, "PID");
  const pidOrig = getSegment(parsed, "PID");
  assert.equal(field(pidBack, 3), field(pidOrig, 3), "patient identifier");
  assert.equal(field(pidBack, 5), field(pidOrig, 5), "patient name");
  assert.equal(field(pidBack, 7), field(pidOrig, 7), "birth date");
  assert.equal(field(pidBack, 8), field(pidOrig, 8), "sex");

  const obxBack = getSegment(back, "OBX");
  const obxOrig = getSegment(parsed, "OBX");
  assert.equal(component(field(obxBack, 3), 1), component(field(obxOrig, 3), 1), "observation code");
  assert.equal(field(obxBack, 5), field(obxOrig, 5), "observation value");
  assert.equal(field(obxBack, 6), field(obxOrig, 6), "observation unit");
  assert.equal(field(obxBack, 11), field(obxOrig, 11), "result status");
});

test("hl7ToFhir reads effectiveDateTime from the observation date/time field (OBR-7), not the message header (MSH-7)", () => {
  // buildHl7Message's obsTimestamp override lands in OBR-7; timestamp (MSH-7)
  // is deliberately set to a different moment so the two cannot be confused.
  const raw = buildHl7Message({ timestamp: "20240115103000", obsTimestamp: "20240220091500" });
  const { observation } = hl7ToFhir(parseHL7(raw));
  assert.equal(observation.effectiveDateTime, "2024-02-20T09:15:00");
});

test("hl7ToFhir maps every declared gender code", () => {
  const male = hl7ToFhir(parseHL7(buildHl7Message({ sex: "M" })));
  const female = hl7ToFhir(parseHL7(buildHl7Message({ sex: "F" })));
  const other = hl7ToFhir(parseHL7(buildHl7Message({ sex: "O" })));
  const unknown = hl7ToFhir(parseHL7(buildHl7Message({ sex: "U" })));
  assert.equal(male.patient.gender, "male");
  assert.equal(female.patient.gender, "female");
  assert.equal(other.patient.gender, "other");
  assert.equal(unknown.patient.gender, "unknown");
});

// ---------------------------------------------------------------- editing helpers

test("withField replaces a single field without disturbing the rest of the message", () => {
  const edited = withField(DEFAULT_MESSAGE, "PID", 3, "9999999999^^^RM^CPR");
  const parsed = parseHL7(edited);
  assert.equal(component(field(getSegment(parsed, "PID"), 3), 1), "9999999999");
  // Everything else in PID is unchanged.
  assert.equal(field(getSegment(parsed, "PID"), 5), "TESTPATIENT^ANNA^^^^L");
});

test("withoutSegment removes exactly the named segment", () => {
  const edited = withoutSegment(DEFAULT_MESSAGE, "OBR");
  const parsed = parseHL7(edited);
  assert.equal(getSegment(parsed, "OBR"), undefined);
  assert.ok(getSegment(parsed, "PID"));
  assert.ok(getSegment(parsed, "OBX"));
});

test("buildHl7Message supports overrides for building specific fixtures", () => {
  const raw = buildHl7Message({ code: "HGB", codeText: "Haemoglobin", value: "8.2" });
  const parsed = parseHL7(raw);
  assert.equal(component(field(getSegment(parsed, "OBR"), 4), 1), "HGB");
  assert.equal(field(getSegment(parsed, "OBX"), 5), "8.2");
});

// ---------------------------------------------------------------- OBX-5 round-trip is exact, not just numerically equal

test("HL7 -> FHIR -> HL7 round-trip preserves the exact OBX-5 text for trailing-zero decimals, negatives and integers", () => {
  for (const value of ["12.30", "-4.50", "7", "0.10", "3.00"]) {
    const parsed = parseHL7(buildHl7Message({ value }));
    const back = fhirToHl7(hl7ToFhir(parsed));
    assert.equal(field(getSegment(back, "OBX"), 5), value, `OBX-5 "${value}" should round-trip exactly`);
  }
});

test("the documented LOSSY_FIELDS list is exactly the diff, even for a decimal OBX-5 value that Number() would reformat", () => {
  const parsed = parseHL7(buildHl7Message({ value: "12.30" }));
  const back = fhirToHl7(hl7ToFhir(parsed));
  const diffs = diffParsedMessages(parsed, back);
  assert.deepEqual(diffs, [...LOSSY_FIELDS].sort());
});
