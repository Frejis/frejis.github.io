// DOM wiring for the type playground. All the language work lives in
// lang.js and infer.js; this file only moves text on and off the screen.

import { parse, evaluate, showValue, LangError } from './lang.js';
import { infer } from './infer.js';

const EXAMPLES = [
  {
    label: 'Polymorphic identity',
    note: 'One function, used at two different types. That is let-polymorphism.',
    source: `let id = \\x -> x in
  (id 1, id "the same function")`,
  },
  {
    label: 'map over a list',
    note: '`map` is written once and fits any element type; the checker picks the right one here.',
    source: `let square = \\n -> n * n in
let evens = filter (\\n -> n % 2 == 0) [1,2,3,4,5,6,7,8] in
  map square evens`,
  },
  {
    label: 'Factorial with let rec',
    note: 'A recursive function types itself: assume a type, infer the body, then insist the two agree.',
    source: `let rec fact n =
  if n <= 1 then 1 else n * fact (n - 1)
in
  map fact [1,2,3,4,5,6]`,
  },
  {
    label: 'Folding a list',
    note: '`foldl` forces the accumulator and the element type into place at once.',
    source: `let sum = foldl (\\acc -> \\n -> acc + n) 0 in
let longest = foldl (\\acc -> \\s -> if length s > length acc then s else acc) [] in
  (sum [3,1,4,1,5,9,2,6], longest [[1],[1,2,3],[1,2]])`,
  },
  {
    label: 'Branches disagree',
    broken: true,
    note: 'Only one branch runs, but the rest of the program cannot tell which, so both must have the same type.',
    source: `let describe = \\n ->
  if n > 100 then "large" else n
in
  describe 7`,
  },
  {
    label: 'Int plus String',
    broken: true,
    note: 'No implicit conversion, and the message says what to use instead.',
    source: `let greet = \\name -> "hello " ++ name in
  1 + greet "world"`,
  },
  {
    label: 'Occurs check',
    broken: true,
    note: 'Applying a value to itself would need a type that contains itself. There is no finite such type.',
    source: `\\x -> x x`,
  },
];

const el = (id) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node;
};

const source = el('source');
const highlight = el('highlight');
const programType = el('program-type');
const programValue = el('program-value');
const errorPanel = el('error-panel');
const errorMessage = el('error-message');
const errorExcerpt = el('error-excerpt');
const errorPhase = el('error-phase');
const bindingsBody = el('bindings');
const bindingsEmpty = el('bindings-empty');
const traceList = el('trace');
const traceEmpty = el('trace-empty');
const traceCount = el('trace-count');
const exampleRow = el('examples');
const exampleNote = el('example-note');
const status = el('status');

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PHASE_WORD = { parse: 'while reading the program', type: 'while checking types', run: 'while running the program' };

function renderHighlight(text, span) {
  // A trailing newline needs a spare line or the layers fall out of sync.
  const padded = text.endsWith('\n') ? `${text}\n` : text;
  if (!span) {
    highlight.innerHTML = escapeHtml(padded);
    return;
  }
  const start = Math.max(0, Math.min(span.start, padded.length));
  const end = Math.max(start, Math.min(span.end, padded.length));
  const marked = padded.slice(start, end);
  highlight.innerHTML =
    escapeHtml(padded.slice(0, start)) +
    `<span class="squiggle${marked.length ? '' : ' empty'}">${escapeHtml(marked)}</span>` +
    escapeHtml(padded.slice(end));
}

function showError(err, text) {
  errorPanel.hidden = false;
  errorMessage.textContent = err.message;
  errorPhase.textContent = `Reported ${PHASE_WORD[err.phase] ?? 'while checking'}.`;
  source.title = err.message;

  const span = err.span ?? { start: text.length, end: text.length };
  const lineStart = text.lastIndexOf('\n', Math.max(0, span.start - 1)) + 1;
  const lineEndRaw = text.indexOf('\n', span.start);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd);
  const lineNumber = text.slice(0, lineStart).split('\n').length;
  const column = span.start - lineStart;
  const width = Math.max(1, Math.min(span.end, lineEnd) - span.start);

  errorExcerpt.innerHTML =
    `${String(lineNumber).padStart(2, ' ')} | ${escapeHtml(line)}\n` +
    `   ${' '.repeat(column)}<span class="caret">${'^'.repeat(width)}</span>`;
}

function clearError() {
  errorPanel.hidden = true;
  errorMessage.textContent = '';
  errorExcerpt.textContent = '';
  errorPhase.textContent = '';
  source.title = '';
}

function renderBindings(bindings) {
  bindingsBody.replaceChildren();
  bindingsEmpty.hidden = bindings.length > 0;
  for (const binding of bindings) {
    const row = document.createElement('tr');
    // A type still containing a lowercase variable name is polymorphic.
    if (/\b[a-z]\b/.test(binding.pretty)) row.className = 'poly';
    const name = document.createElement('td');
    name.className = 'name';
    name.textContent = binding.name;
    const type = document.createElement('td');
    type.className = 'type';
    type.textContent = binding.pretty;
    row.append(name, type);
    bindingsBody.append(row);
  }
}

function renderTrace(steps) {
  traceList.replaceChildren();
  traceEmpty.hidden = steps.length > 0;
  traceCount.textContent = steps.length ? `${steps.length} steps` : '';
  for (const step of steps) {
    const item = document.createElement('li');
    item.className = step.kind;
    const text = document.createElement('span');
    text.className = 'step';
    text.textContent = step.text;
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = step.why ?? '';
    item.append(text, why);
    traceList.append(item);
  }
}

function analyse() {
  const text = source.value;
  status.classList.remove('working');
  status.textContent = 'ready';

  let ast;
  try {
    ast = parse(text);
  } catch (err) {
    if (!(err instanceof LangError)) throw err;
    programType.textContent = 'not a valid program';
    programType.className = 'value unknown';
    programValue.textContent = '\u2014';
    programValue.className = 'value unknown';
    renderHighlight(text, err.span);
    renderBindings([]);
    renderTrace([]);
    showError(err, text);
    status.textContent = 'parse error';
    status.classList.add('working');
    return;
  }

  let result;
  try {
    result = infer(ast);
  } catch (err) {
    if (!(err instanceof LangError)) throw err;
    programType.textContent = 'does not typecheck';
    programType.className = 'value unknown';
    programValue.textContent = 'not run';
    programValue.className = 'value unknown';
    renderHighlight(text, err.span);
    renderBindings([]);
    renderTrace([]);
    showError(err, text);
    status.textContent = 'type error';
    status.classList.add('working');
    return;
  }

  programType.textContent = result.pretty;
  programType.className = 'value';
  renderBindings(result.bindings);
  renderTrace(result.trace);

  // Types checked out, so the only failures left are honest runtime ones
  // (division by zero, head of an empty list, non-termination).
  try {
    programValue.textContent = showValue(evaluate(ast));
    programValue.className = 'value result';
    renderHighlight(text, null);
    clearError();
  } catch (err) {
    if (!(err instanceof LangError)) throw err;
    programValue.textContent = 'stopped';
    programValue.className = 'value unknown';
    renderHighlight(text, err.span);
    showError(err, text);
    status.textContent = 'runtime error';
    status.classList.add('working');
  }
}

function syncScroll() {
  highlight.scrollTop = source.scrollTop;
  highlight.scrollLeft = source.scrollLeft;
}

function resize() {
  // The highlight layer is in flow and sets the height; the textarea is
  // absolutely positioned over it, so growing the text grows the box.
  syncScroll();
}

let timer = 0;
function schedule() {
  status.textContent = 'typing';
  status.classList.add('working');
  clearTimeout(timer);
  timer = setTimeout(() => {
    analyse();
    resize();
  }, 150);
}

function load(example, button) {
  source.value = example.source;
  exampleNote.textContent = example.note;
  for (const other of exampleRow.children) other.classList.toggle('active', other === button);
  renderHighlight(source.value, null);
  analyse();
  resize();
}

for (const example of EXAMPLES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = example.label;
  if (example.broken) button.classList.add('broken');
  button.addEventListener('click', () => load(example, button));
  exampleRow.append(button);
}

source.addEventListener('input', () => {
  renderHighlight(source.value, null);
  schedule();
});
source.addEventListener('scroll', syncScroll);

source.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || event.shiftKey) return;
  event.preventDefault();
  const { selectionStart: start, selectionEnd: end, value } = source;
  source.value = `${value.slice(0, start)}  ${value.slice(end)}`;
  source.selectionStart = source.selectionEnd = start + 2;
  renderHighlight(source.value, null);
  schedule();
});

load(EXAMPLES[1], exampleRow.children[1]);
