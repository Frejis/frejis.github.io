# Portfolio project conventions

Read this before writing any code in `projects/`. Every project follows it so the
whole portfolio looks like one person built it.

## Audience

A hiring manager or tech lead who spends **90 seconds** on the page. They may not
know cryptography or type theory. They must, within 5 seconds of opening
`index.html`, see something moving/interactive that they can poke at, and within
30 seconds understand what was hard about it.

## Hard technical rules

1. **Zero build step. Zero dependencies.** Plain HTML + CSS + ES modules
   (`<script type="module">`). No npm install, no bundler, no framework, no CDN
   links. Opening `index.html` from disk with a double-click, or serving the repo
   root with any static server, must work. This is deliberate: it means the
   demos still run in five years and a reviewer can read the source directly.
2. **Node's built-in test runner** for logic tests: files named `*.test.js`, run
   with `node --test`. Only `node:test` and `node:assert/strict` imports allowed.
   Pure logic lives in `.js` modules importable by both the browser and Node -
   no DOM access at module top level.
3. **Modern browser APIs are fine** (WebCrypto, BigInt, Canvas, `<dialog>`,
   CSS grid, `performance.now()`). No polyfills, no legacy support.
4. Shared stylesheet: `../shared/theme.css` (the file is at
   `projects/shared/theme.css`, one level up from a project folder - NOT
   `../../shared/`, which resolves outside `projects/` and 404s), linked *before* the project's own
   `style.css`. Use its CSS custom properties rather than hardcoded colours.
   Never edit `shared/theme.css` from inside a project task.

## Required files per project folder

```
projects/aN-slug/
  index.html      the demo - self-explanatory, interactive
  style.css       project-specific styling only
  <logic>.js      pure, tested modules (name them for what they do)
  app.js          DOM wiring, imports the logic modules
  *.test.js       node --test, meaningful assertions
  README.md
```

## README shape

```markdown
# Title
One-sentence pitch a non-expert understands.

**[▶ Open the live demo](./index.html)**

![screenshot or gif](...)        <- optional, only if a real file exists

## What you are looking at
2-4 sentences. Plain language.

## Why this was hard
The actual engineering/mathematical decision. 5 lines. Be specific and honest.

## Run it
Instructions - opening index.html, and `node --test` for the tests.

## What this is not
Honest limitations / threat model. Never oversell.
```

Never invent numbers in a README. Every benchmark figure quoted must come from a
benchmark that actually runs in the page or in a test.

## Interaction design rules

- **Show the machinery, not just the result.** The point of each project is to
  make an invisible process visible: step through it, animate it, chart it.
- Every demo needs **sensible defaults preloaded** so it does something
  interesting before the user types anything. Never open on an empty form.
- Where there is a benchmark, render it as a **chart drawn from measurements
  taken live in the browser**, not a static image or hardcoded array.
- Prefer one excellent visualization over three mediocre panels.
- Plain-language labels. "The server cannot read this" beats "AES-256-GCM".
  Put the precise term second, in smaller text.
- Must work at 1280px wide and degrade sanely to mobile.

## Light and dark themes (required on every page)

The portfolio ships two palettes. `shared/theme.css` defines both under the
same variable names and `shared/theme-toggle.js` injects the toggle button, so
a page needs no markup of its own. Every page must include, after the
stylesheet links:

```html
<script src="../shared/theme-toggle.js" defer></script>
```

(`../../shared/theme-toggle.js` from a blog post, which sits one level deeper.)

Rules:

1. **Never name a colour in a project.** No hex, no `rgb()`, no colour keyword
   in a project's `style.css` or `app.js`. Use the shared variables:
   `--bg`, `--bg-raised`, `--bg-inset`, `--border`, `--border-strong`,
   `--text`, `--text-dim`, `--text-faint`, `--accent`, `--accent-hover`,
   `--accent-dim`, `--on-accent`, `--good`, `--warn`, `--bad`, `--alt`.
   A hardcoded colour is invisible in dark mode and wrong in light mode, which
   is exactly the bug that is hardest to notice.

2. **Canvas cannot inherit CSS.** Read colours with
   `getComputedStyle(document.body).getPropertyValue("--border")` at DRAW time,
   never from a value cached when the module loaded - a cached value keeps the
   old palette forever.

3. **Repaint on theme change.** The toggle dispatches a `themechange` event on
   `document`. Any page that draws to a canvas must listen and redraw:

   ```js
   document.addEventListener("themechange", () => redrawEverything());
   ```

   Charts already on screen do not repaint themselves, and a dark chart on a
   light page is the most obvious possible defect.

4. **Both palettes must be legible.** A colour that reads well on near-black
   often fails on near-white. Check text, borders, disabled controls, chart
   gridlines and every status colour in both.

## Explaining it to a non-expert (required on every page)

The reader is a hiring manager, a recruiter, or an engineer from another
field. Assume they have never heard of the technique. A page that only makes
sense to someone who already knows the subject has failed at its job, which is
to make invisible work legible.

Four things every demo must have:

1. **A "why this matters" block** immediately under the page header, before any
   control. Two or three sentences in a `.note`: what real-world problem this
   solves, who has that problem, and what goes wrong without it. Name a
   concrete situation, not an abstraction - "your bank stores your password"
   beats "authentication systems". No jargon at all in this block; the precise
   terms come later.

2. **A plain-language result line after every interaction.** When the user
   presses a button, steps a protocol, or runs a benchmark, the page must say
   in one sentence what just happened and what it means. Not "p99 = 263 us" but
   "the slowest 1 in 100 operations took 263 microseconds - still fast enough
   that a trader would not notice". The number stays; the sentence explains it.

3. **A "so what" payoff on every major panel.** Each section ends with one line
   saying why that result is worth caring about. This is the sentence a reader
   repeats to someone else, so make it the clearest one on the page.

4. **Jargon is introduced, never assumed.** The first time a term appears, give
   it in plain words with the technical name second and smaller - "a checksum
   (CRC-16)", "reordering the sum one variable at a time (the sumcheck
   protocol)". After that, use the real term freely.

Accuracy outranks accessibility. An explanation that is simple and wrong is
worse than one that is technical and right, so every claim must match what the
code actually does. Do not add analogies that overstate the demo's scope, and
do not describe a capability the project does not have.

Keep it tight. This is extra prose on a page that already has a lot; prefer one
excellent sentence to a paragraph, and never repeat the same explanation twice
on one page.

## Voice

Confident, concrete, understated. No marketing language, no emoji in code or
headings, no exclamation marks. British/Danish-neutral English. Explain *why*
something matters before *how* it works.
