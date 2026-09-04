# Type playground

A small language where you never write a type, and the compiler works all of them out for you, in the browser, as you type.

**[▶ Open the live demo](./index.html)**

## What you are looking at

An editor with a tiny functional language in it. Nothing in the program says what anything
is: no `int n`, no `: string`. As you type, the page re-reads the program, works out the type
of every name and of the whole expression, underlines anything that cannot possibly work, and
runs it. The panel on the right shows the actual steps it took to reach that conclusion, not a
summary of them.

The technique is Hindley-Milner type inference, the thing under the hood of OCaml, Haskell,
Elm and the parts of TypeScript, Rust and Swift where you leave the annotations off. The point
worth 90 seconds of your time is the second half: it figures out the types so you do not have
to, and when it cannot, it tells you exactly which two things disagreed and where.

## Why this was hard

- **Errors, not failures.** Textbook unification fails with "cannot unify t3 with t7", which is
  useless to a human. Every constraint here is created with the span it came from and a
  sentence explaining what was being compared, so the failure is phrased in the terms the
  reader is looking at. On a mismatch it reports the two *whole* types the constraint started
  from, not the innermost pair that happened to clash: `[Int]` against `[Bool]` reads better
  than `Int` against `Bool` when you are looking at two lists.
- **Let-polymorphism is where the subtlety is.** `let id = \x -> x in (id 1, id true)` must
  typecheck; the same thing with `id` bound by a lambda must not. That is generalization, and
  getting it right means only generalizing variables that are not still tied to something in
  the surrounding environment.
- **The occurs check** is three lines of code and the only thing standing between you and an
  infinite type when someone writes `\x -> x x`.
- **Spans on every node,** from the tokenizer up, because an underline in the wrong place is
  worse than no underline.
- The editor is a `<textarea>` over a `<pre>` that holds the squiggle. Both layers must agree
  on padding, font, line height and wrapping to the pixel, or the underline drifts off the
  error.

## Error messages I am proud of

What a naive implementation says, against what this one does. Every line below is copied from
a real run of the code in this folder.

**If branches that disagree** - `if n > 100 then "large" else n`

- Before: `unification failure: String vs Int`
- After: `This branch has type Int but the other branch has type String. Both branches of an
  `if` have to agree, because only one of them runs and the rest of the program cannot tell
  which.` - underlining `n`, the branch that is out of step.

**Adding a number to text** - `1 + greet "world"`

- Before: `type error at 1:5`
- After: ``The right side of `+` has type String, but `+` needs whole numbers (Int) to add. To
  join two pieces of text use `++`.`` - underlining the whole call `greet "world"`, not just
  the operator.

**Occurs check** - `\x -> x x`

- Before: `occurs check failed`
- After: `This value would have to contain itself: its type a would need to be the same as
  a -> b. That is an infinite type, so no finite type fits.`

**Mixed list** - `[1, 2, true]`

- Before: `Bool != Int`
- After: `This list element has type Bool, but the earlier elements have type Int. A list holds
  one type of thing.` - underlining `true`.

**Applying a non-function** - `1 2`

- Before: `cannot unify Int with t0 -> t1`
- After: `This is not a function: the thing being applied has type Int, so it cannot take an
  argument.`

## The language

```
let x = e in e            let rec f n = e in e        \x -> e     fun x -> e
if c then a else b        [1,2,3]      1 :: xs        (a, b)      "text" ++ "more"
+ - * / %   < <= > >=   == !=   && ||
map filter foldl length head tail fst snd show
```

Integers, booleans and strings. Comments start with `--`.

## Run it

Open `index.html` in a browser. No build step, no dependencies, no server needed.

Tests, from the repository root:

```
node --test "projects/a3-type-playground/*.test.js"
```

(or `node --test` from inside the folder; passing a bare directory to `--test` is
rejected by Node 24 on Windows.)

The suite covers tokenizer spans, parser structure and precedence, evaluator results, inferred
type strings, let-polymorphism against its lambda-bound counterexample, and each broken example
checked for the right span and the right types named in the message.

## What this is not

- **Not a compiler.** There is no code generation of any kind; the evaluator walks the AST.
- **No modules, no records, no type classes, no user-defined types.** One expression per
  program, a fixed set of builtins, and no way to define your own data.
- **No overloading.** `+` is integers only and `==` is structural equality on whatever both
  sides turn out to be; a real language would need type classes or ad-hoc rules here.
- **No mutation, no effects, no I/O.** `show` returns a string, it does not print.
- **Recursion is stopped, not analysed.** A program that does not terminate is cut off by a
  step and depth budget and reported as a runtime error. There is no totality checking.
- **Type variables are not scoped in error messages** the way a mature compiler manages, so a
  large program's message can name a variable `d` without saying where `d` came from.
