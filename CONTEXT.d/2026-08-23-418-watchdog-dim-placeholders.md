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
  row. Two deliberate asymmetries: menu rows are counted on the RAW text (a
  selector's unfocused rows may render dim, and losing them would weaken the
  menu guard -- the mis-send direction), and a missing or misaligned styled
  read is ignored entirely, restoring the old fail-closed posture.
- The adapter method is optional (`getTailNonDim?`), so every existing
  test/stub and any future text-only tail source keeps the old behavior.

The trap for future edits: do NOT blanket-blank dim cells before the whole
gate. Permission menus may dim their unfocused rows; blanking them would
collapse a menu into a sendable pane and turn an availability bug into a
mis-send (auto-approving a permission prompt). Dim-awareness belongs to the
draft signal only.
