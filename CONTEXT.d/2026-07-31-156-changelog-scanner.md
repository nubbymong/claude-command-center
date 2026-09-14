## 2026-07-31 -- gen-changelog: make the literal scanner comment-aware (#156)

`loadChangelog()` slices the `changelog` array out of the TS source by bracket-matching so
the generator needs no TS toolchain. It tracked string quotes but had NO notion of comments,
so a single apostrophe in a `//` comment inside the array -- "the entry's version", the most
natural English to write -- opened a phantom string. Depth tracking stopped, the slice ended
in the wrong place, and it died as:

    SyntaxError: Unexpected token ')'   at new Function (<anonymous>)

pointing at generated code, with nothing suggesting the real cause. That cost time twice: the
source file carries a NOTE telling authors not to write an apostrophe in a comment, which is
a workaround standing in for a fix.

- Scanner now tracks `//` and block comments. Comment detection sits AFTER the inString
  branch on purpose, so a `//` inside a URL in a description does not open a comment.
- Extracted the scanner as a pure exported `sliceArrayLiteral(src, anchor)`. The bug is
  invisible against the real changelog.ts -- which happens not to contain such a comment
  today -- so the tests run on synthetic sources. A test against the real file would have
  passed either way and proved nothing.
- The `new Function` eval is wrapped: a failure now names the source file, says the array
  must stay a pure data literal, and points at comments as the usual cause, instead of
  surfacing a raw SyntaxError against `<anonymous_script>`.
- Unterminated-literal error message likewise names the likely cause.

Verified behaviour-preserving: `npm run changelog` produces a byte-identical CHANGELOG.md.
Verified discriminating: reverting the comment awareness fails 3 of 12 cases, including the
issue's exact repro.

The NOTE in src/renderer/changelog.ts can now be relaxed, but is deliberately left in place --
it also warns against non-literal expressions in the array, which is still a real constraint.
