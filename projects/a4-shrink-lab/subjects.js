// Subjects under test for Shrink Lab. A mix of correct implementations
// (properties should always pass) and subtly buggy ones (properties should
// fail, and shrinking should reduce the counterexample to something small).
// Each subject exports: id, name, description (plain language, what the
// property claims), buggy (bool, for the UI badge), gens (array of pbt
// generators matching the property's arguments), property(...args) -> bool.

import { int, array, string, tuple } from "./pbt.js";

// --- correct: sorting twice is the same as sorting once (idempotence) -----

function mergeSort(arr) {
  if (arr.length <= 1) return arr.slice();
  const mid = Math.floor(arr.length / 2);
  const left = mergeSort(arr.slice(0, mid));
  const right = mergeSort(arr.slice(mid));
  const out = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    out.push(left[i] <= right[j] ? left[i++] : right[j++]);
  }
  while (i < left.length) out.push(left[i++]);
  while (j < right.length) out.push(right[j++]);
  return out;
}

const sortIdempotent = {
  id: "sort-idempotent",
  name: "sort() is idempotent",
  description: "Sorting an array twice gives the same result as sorting it once.",
  buggy: false,
  gens: [array(int(-50, 50), { maxLength: 40 })],
  property(arr) {
    const once = mergeSort(arr);
    const twice = mergeSort(once);
    return once.length === twice.length && once.every((v, i) => v === twice[i]);
  },
};

// --- correct: reversing twice returns the original array ------------------

const reverseTwice = {
  id: "reverse-twice",
  name: "reverse(reverse(xs)) === xs",
  description: "Reversing an array twice gives back the original array.",
  buggy: false,
  gens: [array(int(-50, 50), { maxLength: 40 })],
  property(arr) {
    const twice = arr.slice().reverse().reverse();
    return twice.length === arr.length && twice.every((v, i) => v === arr[i]);
  },
};

// --- buggy: sort() called with no comparator sorts lexicographically -------
// Array.prototype.sort() with no compare function coerces elements to
// strings, so numeric order breaks as soon as digit counts differ
// ("10" sorts before "2"). The bug is forgetting the comparator, not the
// sort algorithm itself.

function buggySort(arr) {
  return arr.slice().sort(); // bug: missing (a, b) => a - b
}

const sortStable = {
  id: "sort-lexicographic",
  name: "sort() produces ascending numeric order",
  description: "After sorting, every element is less than or equal to the next one.",
  buggy: true,
  gens: [array(int(-50, 50), { maxLength: 40 })],
  property(arr) {
    const sorted = buggySort(arr);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1] > sorted[i]) return false;
    }
    return true;
  },
};

// --- buggy: binary search loop bound excludes the final candidate ----------
// The loop runs `while (lo < hi)` instead of `while (lo <= hi)`, so once the
// search window narrows to a single index (lo === hi) the loop exits without
// checking it. Any array with exactly one remaining candidate at that point
// - trivially, any one-element array - reports "not found" for a value that
// is present.

function buggyBinarySearch(arr, target) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) { // bug: should be lo <= hi
    const mid = Math.floor((lo + hi) / 2);
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

const binarySearchFindsPresent = {
  id: "binary-search-off-by-one",
  name: "binarySearch finds every element that is present",
  description: "Searching for a value that is genuinely in the (sorted) array must find it.",
  buggy: true,
  gens: [array(int(-30, 30), { minLength: 1, maxLength: 30 })],
  property(rawArr) {
    const arr = [...new Set(rawArr)].sort((a, b) => a - b);
    if (arr.length === 0) return true;
    // pick a target that is definitely present, deterministically from the array
    const target = arr[arr.length - 1];
    return buggyBinarySearch(arr, target) !== -1;
  },
};

// --- buggy: run-length encode/decode round trip breaks on runs >= 10 -------
// The encoder emits the run length as a single character via
// String.fromCharCode(count), which is fine for counts 1-9 as a *digit*
// mental model but the decoder re-parses it assuming single ASCII digits,
// so any run of 10 or more identical characters decodes incorrectly.

function rleEncode(s) {
  if (s.length === 0) return "";
  let out = "";
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j < s.length && s[j] === s[i]) j++;
    const runLength = j - i;
    out += String(runLength) + s[i]; // bug: multi-digit lengths break the decoder below
    i = j;
  }
  return out;
}

function rleDecode(encoded) {
  let out = "";
  let i = 0;
  while (i < encoded.length) {
    // bug: assumes the run-length is exactly one digit
    const countChar = encoded[i];
    const ch = encoded[i + 1];
    const count = Number(countChar);
    out += ch.repeat(count);
    i += 2;
  }
  return out;
}

const rleRoundTrip = {
  id: "rle-round-trip",
  name: "decode(encode(s)) === s",
  description: "Run-length encoding then decoding must return the original string.",
  buggy: true,
  gens: [string({ minLength: 0, maxLength: 20, charMin: 97, charMax: 99 })], // 'a'-'c' to force long runs
  property(s) {
    return rleDecode(rleEncode(s)) === s;
  },
};

// --- buggy: dateAddDays mishandles the month boundary ----------------------
// Uses a fixed 30-days-per-month table lookup instead of letting Date's
// own arithmetic (or a correct days-in-month calc) carry the overflow, so
// adding days across a month with 31 days lands one day short.

function buggyAddDays(year, month, day, days) {
  // month is 1-12
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let y = year, m = month, d = day + days;
  while (true) {
    const len = m === 2 && isLeap(y) ? 29 : 30; // bug: always treats non-Feb months as 30 days
    if (d <= len) break;
    d -= len;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return { year: y, month: m, day: d };
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function realAddDays(year, month, day, days) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const dateAddDays = {
  id: "date-add-days",
  name: "dateAddDays matches calendar arithmetic",
  description:
    "Adding N days to a date should land on the same day as the calendar would give you, " +
    "including when the addition crosses a month boundary.",
  buggy: true,
  gens: [int(2000, 2100), int(1, 12), int(1, 28), int(0, 45)],
  property(year, month, day, days) {
    const got = buggyAddDays(year, month, day, days);
    const want = realAddDays(year, month, day, days);
    return got.year === want.year && got.month === want.month && got.day === want.day;
  },
};

// --- correct: string length is preserved by concatenation -----------------

const concatLength = {
  id: "concat-length",
  name: "concat preserves total length",
  description: "The length of a + b always equals length(a) + length(b).",
  buggy: false,
  gens: [tuple(string({ maxLength: 20 }), string({ maxLength: 20 }))],
  property([a, b]) {
    return (a + b).length === a.length + b.length;
  },
};

export const subjects = [
  sortIdempotent,
  reverseTwice,
  sortStable,
  binarySearchFindsPresent,
  rleRoundTrip,
  dateAddDays,
  concatLength,
];

export function getSubject(id) {
  const s = subjects.find((s) => s.id === id);
  if (!s) throw new Error(`unknown subject: ${id}`);
  return s;
}
