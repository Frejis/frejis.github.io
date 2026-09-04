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

## Voice

Confident, concrete, understated. No marketing language, no emoji in code or
headings, no exclamation marks. British/Danish-neutral English. Explain *why*
something matters before *how* it works.
