## 2026-08-23 -- #418 watchdog send gate: the styled read (dim placeholders)

Follow-up from the #266 ADR-009 review (finding N1). `canSendNow` treated any
`❯ <text>` row as a draft/picker and deferred. But Claude Code renders DIM
placeholder text in an otherwise-empty input -- "Press up to edit queued
messages" whenever the queue is non-empty, "Message @agent…" in an agent view,
"Comment on N selected lines…" over an IDE selection, the model-generated
prompt suggestion -- states that coexist with a live rate limit indefinitely.
The gate fails closed, so it deferred forever: the auto-retry silently never
fired, exactly when it should have.

The fix keys the draft signal on the **dim attribute**, not on a placeholder
denylist (wording changes with every claude.exe release; the attribute is the
render's own statement that the text is a hint):

- `readPanePair` (watchdog-manager) serializes the headless pane twice from
  one buffer walk: `text` (translateToString, unchanged for every other
  detector) and `nonDim` -- the same rows with every dim cell blanked to a
  space, trailing blanks trimmed in lockstep so the two stay aligned
  line-for-line.
- `canSendNow(text, nonDimText?)`: a caret/boxed/bare-prompt row counts as a
  DRAFT only if non-dim ink follows the prompt glyph in the aligned styled
  row. Two deliberate asymmetries: BOTH menu signals (numbered rows AND the
  two-caret-row picker count) stay on the RAW text (a selector's rows may
  render dim, and losing them would weaken the menu guard -- the mis-send
  direction), and a missing or misaligned styled read is ignored entirely,
  restoring the old fail-closed posture.
- The adapter method is optional (`getTailNonDim?`), so every existing
  test/stub and any future text-only tail source keeps the old behavior.

What the adversarial round (decompiling the real claude.exe renderer) forced,
and future editors must not undo:

- **The cursor is INVERSE, not dim.** A focused empty input renders the
  placeholder as `inverse(first char) + dim(rest)` -- so a dim-only mask left
  `❯ P` and the gate still deferred forever (the fix would have shipped
  without fixing the bug). The mask blanks `isDim() || isInverse()` cells:
  the inverse cell is the cursor, never draft ink.
- **Ink is checked BY COLUMN after the glyph found in the RAW row**, never by
  re-running the anchored shape regex on the masked line: claude.exe dims the
  prompt pointer whenever isLoading, and a masked re-match would blank the
  glyph, fail the regex, and flip a live type-ahead draft from refuse to SEND.
  Same for dim box gutters. Empty cells serialize as spaces so columns hold.
- **Only a LONE inverse cell is the cursor.** Round 2 of the review: blanket
  inverse masking blanked whole inverse RUNS -- the `[Image #1]` chip (which
  claude.exe renders fully inverse when the cursor snaps to its edge) and an
  inverse-highlighted picker row -- flipping a real draft into a sendable
  pane. The mask blanks an inverse cell only when neither neighbour is
  inverse; a multi-cell inverse run is content.
- Accepted residuals (documented, judged unreal-rare): a ONE-character draft
  with the cursor sitting ON that character masks to blank and would send
  (two characters already refuse); and a single-option ALL-DIM caret picker
  row no longer gates (claude.exe dims only disabled rows, where Enter is
  inert -- and a picker with one option is not a real render).

The trap for future edits: do NOT blanket-blank dim/inverse cells before the
whole gate. Permission menus may dim their rows; blanking them before the menu
counters would collapse a menu into a sendable pane and turn an availability
bug into a mis-send (auto-approving a permission prompt). Attribute-awareness
belongs to the draft signal only.
