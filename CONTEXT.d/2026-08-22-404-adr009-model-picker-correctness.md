## 2026-08-22 -- #404 ADR-009 follow-up: two MAJOR correctness defects fixed

The adversarial pass on PR #404 (`fix/385-versioned-model-picker`) returned PASS
on the security question but two MAJOR correctness defects. Both fixed here,
each with a test proven red against the pre-fix code.

### MAJOR-1 -- the article parser harvested a support-site URL slug

`src/main/sentinel/sentinel-model-article.ts` regexed the WHOLE ~345 KB article
HTML with `claude-(opus|sonnet|haiku|fable|mythos)-\d[0-9a-z-]*`. That trailing
`[0-9a-z-]*` swallows words, so a sidebar link's href
(`.../15424964-claude-fable-5-on-your-plan`) came back as a model id. Verified
against the real live article: the parser returned 11 ids, the first being
`claude-fable-5-on-your-plan`. `registryIdCovers()` cannot match that against
`claude-fable-5`, so the Sentinel LIVE arm raised a permanent, stable-id'd
`models:missing:claude-fable-5-on-your-plan` ("New model: ...") on EVERY startup
of every Sentinel-enabled build. `MIN_PLAUSIBLE_IDS` never helped -- 11 > 3.

Three independent defences, because each covers a different escape:

1. **Text, not markup.** `visibleText()` drops `<script>`/`<style>` bodies whole
   and replaces every remaining tag with a space. The phantom was never in the
   article's prose, it was inside a tag -- so no href, title, data-attribute,
   CSS class or embedded JSON blob can contribute a "model" at all. Replacing a
   tag with a SPACE (not `''`) also heals an id that inline markup split
   (`claude --model<b> </b>claude-haiku-4-5-20251001`) without splicing two
   separate tokens together.
2. **Whole-token shape.** `MODEL_ID_RE` now allows only NUMERIC segments after
   the family and ends in a negative lookahead. Truncating the slug back to
   `claude-fable-5` would be just as wrong (a slug for an article about a
   *future* model would invent that model), so the lookahead drops the whole
   token rather than trimming it.
3. **Section scope.** `supportedModelsSection()` slices from the "Supported
   models" heading to the next heading of the same or higher level, so a model
   named elsewhere on the page (a retired one in a "no longer available" note)
   is not reported as newly offered. Falls back to the whole document when that
   heading is gone -- (1)+(2) make the fallback safe on its own, and a document
   yielding fewer than `MIN_PLAUSIBLE_IDS` is already treated as unreadable.

Fixture: `tests/fixtures/model-article/claude-code-model-configuration.trimmed.html`
-- three slices of the REAL page, captured 2026-08-22, markup unmodified: the
sidebar list carrying the phantom href, the Supported models section, and the
`--model` examples section. 6.6 KB rather than 345 KB. One test asserts the
fixture still CONTAINS the phantom href, so a future trim cannot make the other
tests pass for the wrong reason.

Behaviour change worth knowing: a trailing hyphen is no longer trimmed off an
id. `claude-opus-5-` is now rejected outright, because "the token continues" is
exactly the signal that this is a slug and not a model. The old test asserting
the trim was rewritten to assert the rejection.

### MAJOR-2 -- `m.patterns is not iterable` took down the footer strip

`matchEntry()` step 4 did `for (const p of m.patterns)`. The Q3 guard that skips
a malformed entry lives in `buildModelPickerRows`, NOT in the matcher, so an
entry with no `patterns` -- including a legitimately ALIAS-ONLY one, a shape a
user may reasonably hand-write into `registry-overlay.json` -- threw a TypeError
out of `resolvePickedModelId` and `buildEffortRows`. `SessionStatusStrip` calls
`resolvePickedModelId` on EVERY render with a statusline-supplied model name, so
one such entry (or one model name the registry could not place) killed the whole
footer strip.

Fixed in the MATCHER, not the loader: `usableEntries()` filters to entries with a
string `id`, `patterns` degrades to `[]` when it is not an array, `aliases` is
checked with `Array.isArray` (a bare-string `aliases` would otherwise
substring-match via `String.prototype.includes`), and non-string patterns are
skipped. Hardening the loader instead would have broken an alias-only entry,
which is the shape most worth keeping working -- there is a test that it stays
reachable by id, alias and prefix.

Writing the tests found a SECOND crash in the same function: the label scan in
`resolvePickedModelId` did `registry.models.find((m) => ... m.label ...)`, which
throws on a null entry. Same `usableEntries()` fix.

### The two MINORs, also addressed

- `SessionStatusStrip.onModel` writes a picker value into a live PTY as a
  slash-command LINE with no schema in front of it. It now holds values to the
  same charset the `--model` IPC boundary enforces
  (`pty-handlers.ts`, `/^[a-zA-Z0-9._[\]-]+$/`) via `isWritablePickerValue()`.
  Defence in depth -- the overlay is a local file, not remote input -- but an
  overlay-injected id containing a newline would otherwise have submitted a
  second, attacker-chosen line to Claude Code. The row still LISTS; only the
  write refuses.
- `SessionDialog` reset an unsupported effort only on model CHANGE, so a config
  saved before a model dropped a level (`claude-opus-4-6` + `xhigh`) reopened
  with the chip still selected and re-submitted it on Save without the model
  being touched at all. Now clamped in the `effortLevel` lazy initialiser (load)
  AND again in `handleSubmit`, through one module-level `effortSupportedFor()`
  that reuses the same `effortsForModel` gating the chips use. It fails OPEN: an
  unknown model or an un-hydrated registry enables everything, so clamping can
  never drop an effort it merely failed to verify. Module-level because a helper
  in the component body is still in its TDZ when React calls the initialiser.

### Verification

`npm run typecheck` clean. Full `npx vitest run`: 665 files passed / 2 skipped,
7179 tests passed / 15 skipped / 2 todo, 0 failed.

Revert proof (pre-fix code restored, same tests): 9 failures --
`TypeError: m.patterns is not iterable` from both `resolvePickedModelId` and
`buildEffortRows`, `Cannot read properties of null (reading 'id')` from the
label scan, the phantom id present in the parsed list, and the live arm
producing exactly one finding where the fixed code produces none.
