// app.js — DOM wiring only. All the message model, transform and pipeline
// logic lives in messages.js / pipeline.js, plain modules importable from
// Node as well (see the *.test.js files next to this one).
import {
  parseHL7,
  serializeHL7,
  getSegment,
  buildHl7Message,
  DEFAULT_MESSAGE,
  hl7ToFhir,
  fhirToHl7,
  diffParsedMessages,
} from "./messages.js";
import {
  STAGES,
  runPipeline,
  Ledger,
  DeadLetterQueue,
  FAULTS,
  FAULT_KEYS,
  runBatch,
  summarizeBatch,
} from "./pipeline.js";

const $ = (id) => document.getElementById(id);

const STAGE_INFO = {
  receive: { label: "Receive", blurb: "The raw message arrives from the sending system." },
  parse: { label: "Parse", blurb: "Checks the message is structurally well-formed: the required segments are present, in order, with enough fields." },
  validate: { label: "Validate", blurb: "Checks the content makes sense: a well-formed patient identifier, a plausible code, a numeric value." },
  transform: { label: "Transform", blurb: "Converts the message from HL7 v2 to FHIR, and checks the value is in a physiologically plausible range." },
  enrich: { label: "Enrich", blurb: "Looks up the observation code in a local terminology table and attaches its human-readable name." },
  route: { label: "Route", blurb: "Decides which downstream system the message goes to, and checks this is not a message already delivered before." },
  deliver: { label: "Deliver", blurb: "Sends the message to the destination system." },
};

// ============================================================================
// Shared state: one ledger (idempotency) and one dead-letter queue for the
// interactive editor above the throughput run, which uses its own.
// ============================================================================

const ledger = new Ledger();
const dlq = new DeadLetterQueue();
let currentRaw = DEFAULT_MESSAGE;
let messageCounter = 1;
const DUPLICATE_DEMO_CONTROL_ID = "MSG-DUP-DEMO";

function freshValidMessage() {
  return buildHl7Message({ controlId: `MSG-DEMO-${String(messageCounter++).padStart(4, "0")}` });
}

// ============================================================================
// 1. Trace strip
// ============================================================================

function renderTrace(outcome) {
  const strip = $("trace-strip");
  strip.innerHTML = "";
  STAGES.forEach((stageName, i) => {
    if (i > 0) {
      const arrow = document.createElement("span");
      arrow.className = "trace-arrow";
      arrow.textContent = "\u2192";
      strip.appendChild(arrow);
    }
    const entry = outcome.trace[i];
    const box = document.createElement("button");
    box.type = "button";
    box.className = "trace-box " + (entry ? (entry.pass ? "pass" : "fail") : "unreached");
    box.innerHTML = `<span class="n">${i + 1}</span><span class="l">${STAGE_INFO[stageName].label}</span>`;
    box.title = entry ? entry.reason : "never reached";
    box.addEventListener("click", () => showStageDetail(stageName, entry));
    strip.appendChild(box);
  });

  const failedEntry = outcome.trace.find((t) => !t.pass);
  showStageDetail(failedEntry ? failedEntry.stage : "deliver", failedEntry ?? outcome.trace.at(-1));
  renderVerdict(outcome);
}

function showStageDetail(stageName, entry) {
  const info = STAGE_INFO[stageName];
  const el = $("trace-detail");
  if (!entry) {
    el.innerHTML = `<h3>${info.label}</h3><p class="muted">${info.blurb}</p><p class="faint">Never reached — an earlier stage rejected this message first.</p>`;
    return;
  }
  const statusTag = entry.pass
    ? `<span class="tag good">passed</span>`
    : `<span class="tag bad">rejected here</span>`;
  el.innerHTML = `
    <h3>${info.label} ${statusTag}</h3>
    <p class="muted">${info.blurb}</p>
    <p>${entry.pass ? entry.reason : `<strong>Reason:</strong> ${entry.reason}`}</p>
    ${entry.field ? `<p class="faint">Field or segment at fault: <code class="inline">${entry.field}</code></p>` : ""}
  `;
}

function renderVerdict(outcome) {
  const el = $("trace-verdict");
  if (outcome.terminalState === "delivered") {
    el.innerHTML = `<span class="tag good">delivered</span><span>All seven stages passed and the result reached ${outcome.destination}. Nothing for anyone to chase.</span>`;
  } else if (outcome.terminalState === "duplicate") {
    const entry = outcome.trace.at(-1);
    el.innerHTML = `<span class="tag warn">duplicate, not re-delivered</span><span>${entry.reason} — this message has been sent before, so it is recognised and stopped here rather than delivered again. That is the point: the patient must not end up with two copies of one lab result. Handling a repeat safely is called idempotent delivery.</span>`;
  } else {
    const entry = outcome.trace.find((t) => !t.pass);
    el.innerHTML = `<span class="tag bad">rejected at ${STAGE_INFO[entry.stage].label.toLowerCase()}</span><span>This message never reached the destination system because ${entry.reason}. In production this is the point where someone would otherwise be reading logs on two systems to find out what you can read here in one line.</span>`;
  }
}

// ============================================================================
// 2. Editor + fault buttons
// ============================================================================

function setEditorValue(raw) {
  currentRaw = raw;
  $("hl7-editor").value = raw;
}

function runCurrent(extraOpts = {}) {
  const outcome = runPipeline(currentRaw, { ledger, ...extraOpts });
  renderTrace(outcome);
  renderShapes(outcome);
  if (outcome.terminalState === "rejected") {
    dlq.push(outcome);
    renderDlq();
  }
  return outcome;
}

function setupEditor() {
  const editor = $("hl7-editor");
  setEditorValue(currentRaw);

  editor.addEventListener("input", () => {
    currentRaw = editor.value;
    runCurrent();
  });
  $("run-message").addEventListener("click", () => runCurrent());

  $("reset-message").addEventListener("click", () => {
    setEditorValue(freshValidMessage());
    runCurrent();
  });

  document.querySelectorAll(".fault-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.fault;
      const fault = FAULTS[key];
      if (key === "duplicate") {
        const dupRaw = buildHl7Message({ controlId: DUPLICATE_DEMO_CONTROL_ID });
        if (!ledger.hasDelivered(DUPLICATE_DEMO_CONTROL_ID)) {
          runPipeline(dupRaw, { ledger }); // silently deliver it once first, so resending it demonstrates the duplicate check
        }
        setEditorValue(dupRaw);
        runCurrent();
      } else if (key === "downSystem") {
        setEditorValue(freshValidMessage());
        runCurrent({ forceDeliverDown: true });
      } else {
        setEditorValue(fault.apply(freshValidMessage()));
        runCurrent();
      }
    });
  });

  runCurrent();
}

// ============================================================================
// 3. HL7 vs FHIR side by side
// ============================================================================

function renderShapes(outcome) {
  const hl7View = $("hl7-view");
  const fhirView = $("fhir-view");
  const lossyNote = $("lossy-note");

  hl7View.textContent = outcome.parsed ? serializeHL7(outcome.parsed) : currentRaw;

  if (!outcome.patient || !outcome.observation) {
    fhirView.textContent = "(not available — this message did not reach the transform stage)";
    lossyNote.textContent = "";
    return;
  }

  fhirView.textContent = JSON.stringify({ patient: outcome.patient, observation: outcome.observation }, null, 2);

  const roundTripped = fhirToHl7({ patient: outcome.patient, observation: outcome.observation });
  const diffs = diffParsedMessages(outcome.parsed, roundTripped);
  lossyNote.textContent = diffs.length
    ? `Converting this back to HL7 v2 would differ from the original only in: ${diffs.join(", ")} — all routing/administrative metadata, never clinical content. See the README for why these specific fields are lossy.`
    : "This message round-trips to HL7 v2 with no differences at all.";
}

// ============================================================================
// 4. Dead-letter queue
// ============================================================================

function renderDlq() {
  const list = $("dlq-list");
  const entries = dlq.list();
  $("dlq-count").textContent = `${entries.length} queued`;
  if (entries.length === 0) {
    list.innerHTML = `<p class="faint">Empty — nothing currently rejected.</p>`;
    return;
  }
  list.innerHTML = "";
  for (const entry of entries) {
    const failing = entry.trace.find((t) => !t.pass);
    const row = document.createElement("div");
    row.className = "dlq-entry";
    row.innerHTML = `
      <div class="spread">
        <span class="tag bad">#${entry.id} — rejected at ${STAGE_INFO[entry.failedStage].label.toLowerCase()}</span>
      </div>
      <p class="faint">${failing.reason}</p>
      <textarea class="mono dlq-editor" rows="5" spellcheck="false">${entry.raw}</textarea>
      <div class="row">
        <button type="button" class="dlq-replay primary">Fix and replay</button>
        <span class="dlq-result faint"></span>
      </div>
    `;
    const textarea = row.querySelector(".dlq-editor");
    const replayBtn = row.querySelector(".dlq-replay");
    const resultEl = row.querySelector(".dlq-result");
    replayBtn.addEventListener("click", () => {
      const outcome = dlq.replay(entry.id, textarea.value, ledger);
      setEditorValue(outcome.raw);
      renderTrace(outcome);
      renderShapes(outcome);
      renderDlq();
      if (outcome.terminalState === "delivered") {
        resultEl.textContent = `replayed successfully — delivered to ${outcome.destination}`;
      } else {
        resultEl.textContent = `still failing: ${outcome.trace.find((t) => !t.pass)?.reason ?? outcome.terminalState}`;
      }
    });
    list.appendChild(row);
  }
}

// ============================================================================
// Canvas sizing — see a13-meter-telemetry for why the backing store is sized
// to the CSS box at the device pixel ratio rather than left at the HTML
// width/height attribute.
// ============================================================================

// Read at draw time, never cached: a canvas cannot inherit CSS, so a value
// captured at module load keeps the palette the page opened with.
function chartColours() {
  const css = getComputedStyle(document.body);
  const c = (name) => css.getPropertyValue(name).trim();
  return {
    inset: c("--bg-inset"),
    border: c("--border"),
    faint: c("--text-faint"),
    dim: c("--text-dim"),
    text: c("--text"),
    good: c("--good"),
    warn: c("--warn"),
    bad: c("--bad"),
  };
}

function sizeCanvasForDisplay(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = rect.width || canvas.width;
  const cssHeight = rect.height || canvas.height;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssWidth, h: cssHeight };
}

const compactNumber = (n) => {
  const rounded = Math.round(n);
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1)}M`;
  if (rounded >= 1_000) return `${(rounded / 1_000).toFixed(1)}k`;
  return rounded.toLocaleString();
};

// ============================================================================
// 5. Throughput run
// ============================================================================

const BATCH_BAR_ORDER = [
  { key: "rejected-at-parse", label: "died: parse" },
  { key: "rejected-at-validate", label: "died: validate" },
  { key: "rejected-at-transform", label: "died: transform" },
  { key: "rejected-at-enrich", label: "died: enrich" },
  { key: "rejected-at-route", label: "died: route" },
  { key: "rejected-at-deliver", label: "died: deliver" },
  { key: "duplicate", label: "duplicate" },
  { key: "delivered", label: "delivered" },
];

function drawBatchChart(canvas, summary) {
  const { ctx, w, h } = sizeCanvasForDisplay(canvas);
  const col = chartColours();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = col.inset;
  ctx.fillRect(0, 0, w, h);

  const bars = BATCH_BAR_ORDER.map((b) => ({
    ...b,
    value: summary[b.key] ?? 0,
    color: b.key === "delivered" ? col.good : b.key === "duplicate" ? col.warn : col.bad,
  }));
  const pad = { left: 60, right: 16, top: 30, bottom: 46 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const max = Math.max(...bars.map((b) => b.value), 1) * 1.15;
  const barW = plotW / bars.length;

  ctx.strokeStyle = col.border;
  ctx.fillStyle = col.faint;
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "right";
  for (let g = 0; g <= 4; g++) {
    const y = pad.top + (plotH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.fillText(compactNumber(max * (1 - g / 4)), pad.left - 6, y + 3);
  }

  bars.forEach((b, i) => {
    const barH = (b.value / max) * plotH;
    const x = pad.left + i * barW;
    const y = pad.top + plotH - barH;
    ctx.fillStyle = b.color;
    ctx.fillRect(x + barW * 0.18, y, barW * 0.64, barH);
    ctx.fillStyle = col.text;
    ctx.textAlign = "center";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(b.value.toLocaleString(), x + barW / 2, y - 6);
    ctx.fillStyle = col.dim;
    ctx.font = "10px ui-monospace, monospace";
    // Two-line label so "died: transform" does not overrun its bar's width.
    const words = b.label.split(" ");
    ctx.fillText(words.slice(0, 1).join(" "), x + barW / 2, h - 30);
    ctx.fillText(words.slice(1).join(" "), x + barW / 2, h - 18);
  });
}

// Calibrated timing: a single run of a few hundred messages can complete
// under performance.now()'s ~100us effective resolution in a browser, so
// the run is repeated (accumulating elapsed time and message count) until
// the total is comfortably measurable, then throughput is one honest
// average over however many repeats that took — never a single tiny sample.
// The last batch drawn, kept so a palette change can repaint the chart from
// the same numbers rather than re-running (and re-timing) the batch.
let lastBatch = null;

const MIN_TIMED_MS = 30;
const MAX_REPEATS = 60;

function timedRunBatch(count, faultMix, deliverFailureRate) {
  let totalElapsedMs = 0;
  let totalMessages = 0;
  let repeats = 0;
  let firstResults = null;
  while (totalElapsedMs < MIN_TIMED_MS && repeats < MAX_REPEATS) {
    const seed = 1000 + repeats;
    const t0 = performance.now();
    const results = runBatch(count, faultMix, seed, deliverFailureRate);
    const t1 = performance.now();
    totalElapsedMs += t1 - t0;
    totalMessages += count;
    repeats++;
    if (!firstResults) firstResults = results;
  }
  // Guard: never let a zero-elapsed sample reach the DOM as Infinity.
  const throughput = totalElapsedMs > 0 ? totalMessages / (totalElapsedMs / 1000) : null;
  return { results: firstResults, throughput, repeats, totalElapsedMs, totalMessages };
}

function setupThroughput() {
  const countSlider = $("batch-count");
  const faultRateSlider = $("batch-fault-rate");
  const deliverFailSlider = $("batch-deliver-fail");
  const runBtn = $("batch-run");
  const canvas = $("batch-canvas");
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  const updateLabels = () => {
    $("batch-count-value").textContent = `${Number(countSlider.value).toLocaleString()} messages`;
    $("batch-fault-rate-value").textContent = `${faultRateSlider.value}%`;
    $("batch-deliver-fail-value").textContent = `${deliverFailSlider.value}%`;
  };
  [countSlider, faultRateSlider, deliverFailSlider].forEach((el) => el.addEventListener("input", updateLabels));
  updateLabels();

  const buildFaultMix = () => {
    const faultShare = Number(faultRateSlider.value) / 100;
    const validShare = 1 - faultShare;
    const perFault = faultShare / FAULT_KEYS.length;
    const mix = { valid: validShare };
    for (const key of FAULT_KEYS) mix[key] = perFault;
    return mix;
  };

  const run = async () => {
    runBtn.disabled = true;
    await frame();
    const count = Number(countSlider.value);
    const deliverFailureRate = Number(deliverFailSlider.value) / 100;
    const mix = buildFaultMix();

    const { results, throughput, repeats, totalElapsedMs, totalMessages } = timedRunBatch(count, mix, deliverFailureRate);
    const summary = summarizeBatch(results);
    const totalAccounted = Object.values(summary).reduce((a, b) => a + b, 0);

    const rejected = totalAccounted - (summary.delivered ?? 0) - (summary.duplicate ?? 0);
    $("batch-plain").textContent =
      `Of ${totalAccounted.toLocaleString()} messages pushed through with this fault mix, ` +
      `${(summary.delivered ?? 0).toLocaleString()} arrived at a downstream system, ` +
      `${rejected.toLocaleString()} were stopped by a stage that found something wrong with them, ` +
      `and ${(summary.duplicate ?? 0).toLocaleString()} were repeats that were recognised and not ` +
      `delivered twice. None went missing unaccounted for.`;

    $("batch-stats").innerHTML = `
      <div class="stat"><span class="value">${(summary.delivered ?? 0).toLocaleString()}</span><span class="label">delivered</span></div>
      <div class="stat"><span class="value">${(summary.duplicate ?? 0).toLocaleString()}</span><span class="label">duplicate</span></div>
      <div class="stat"><span class="value">${rejected.toLocaleString()}</span><span class="label">rejected</span></div>
      <div class="stat"><span class="value">${totalAccounted.toLocaleString()}</span><span class="label">total accounted for</span></div>
    `;

    if (throughput === null) {
      $("batch-throughput").textContent =
        `Ran ${totalMessages.toLocaleString()} messages over ${repeats} repeat(s) but the elapsed time measured exactly zero — too fast for this clock to time; try a larger batch.`;
    } else {
      const perDaySeconds = 86400;
      const postedDailyRate = 80000 / perDaySeconds;
      $("batch-throughput").textContent =
        `${Math.round(throughput).toLocaleString()} messages/second — a batch average measured live over ${repeats} repeat(s) ` +
        `totalling ${totalMessages.toLocaleString()} messages in ${totalElapsedMs.toFixed(1)} ms.`;
      $("batch-scale-note").textContent =
        `For scale: the team this demo targets reports roughly 80,000 messages a day, an average of about ` +
        `${postedDailyRate.toFixed(2)} messages/second sustained around the clock — this in-browser run is orders of ` +
        `magnitude faster in isolation because it does none of the actual integration work (no network calls, no ` +
        `real downstream systems, no persistence). It is a demonstration of the pipeline logic, not a load test of an ` +
        `integration platform.`;
    }

    lastBatch = { canvas, summary };
    drawBatchChart(canvas, summary);
    runBtn.disabled = false;
  };

  runBtn.addEventListener("click", run);
  run();
}

// ============================================================================

setupEditor();
renderDlq();
setupThroughput();

document.addEventListener("themechange", () => {
  if (lastBatch) drawBatchChart(lastBatch.canvas, lastBatch.summary);
});
