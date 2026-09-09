# Portfolio hub and writeups

The front page for the other twelve projects, plus a writeup for each one
explaining what it does, how it works and what it deliberately leaves out.

**[▶ Open the live demo](./index.html)**

## What you are looking at

`index.html` is the hub: a card for each of the demos with a
plain-language pitch, topic tags, a link straight into the demo and a link to
its writeup. `posts/aN-slug.html` are the writeups, one per project, each
around 500-800 words covering the problem, what was built, the actual technical
substance, the hardest part, and an honest list of limitations drawn from that
project's own README. The repository root `index.html` is a small landing page
that links here and to the demos directly, so serving or opening the repo
lands somewhere useful.

## Why this was hard

The writing, not the code. Each post has to be accurate enough that someone who
knows the field does not wince, and readable enough that someone who does not
still gets the idea, and every claim in it had to come from the project's real
implementation rather than from what the technique usually does. The hub has
the opposite constraint: a hiring manager gives this ninety seconds, so each
card has to state the point of a project in one sentence with no jargon and get
out of the way.

The posts are plain HTML files rather than a data module rendered by
`post.html?post=...`. A query-string renderer needs JavaScript and a fetch to
work, which breaks when the file is opened from disk over `file://` - and
opening from disk is a rule the whole portfolio keeps.

## Run it

Open `index.html` directly, or serve the repository root with any static
server and browse to `projects/a9-blog/index.html`. No build step, no
dependencies, no JavaScript at all in this project.

There are no tests here: the project is static documents with no logic module
to test. Every other project's tests run with

```
node --test "projects/<slug>/*.test.js"
```

## What this is not

- **No JavaScript, so no interactivity.** This is the one project in the
  portfolio that is deliberately inert; it is the signpost, not an exhibit.
- **Not a blog engine.** Hand-written HTML files with no feed, no index
  data, no tags page and no build step. Adding a post means writing another
  file and adding a card.
- **The writeups summarise, they do not replace the code.** Where a post and a
  project's README disagree in emphasis, the README and the source are the
  authority.
