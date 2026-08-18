## 2026-08-17 -- WebGL stale-glyph repaint covers at-bottom streaming (#273 follow-up, PR #292)

beta.12's #283 repainted only while the user was scrolled up or had just
wheeled; output streaming at the BOTTOM with no scroll (the owner's slicer
stderr) still ghosted and stayed ghosted after the stream stopped, because
nothing repainted. Owner confirmed on beta.12.

Change (renderer-only, `staleGlyphRepaint.ts` + TerminalView wiring):
- every normal-buffer output chunk qualifies for the strong repaint
  (clearTextureAtlas + refresh); alternate-buffer skip and the WebGL-active
  gate (no refresh on the DOM renderer) unchanged;
- two paces: 4/sec while scrolled up / wheel-active (unchanged), 1/sec for
  steady at-bottom streaming -- clearTextureAtlas rebuilds the atlas and re-warms
  ASCII, so a minutes-long log should not pay four of those a second (#273's
  open GPU-cost question);
- one SETTLE repaint 300ms after output goes quiet (through the throttle) --
  clears the ghost the LAST chunk left, which is what the user is otherwise
  left staring at;
- Copilot review: a fast (wheel) request arriving inside its window while a
  slow trailing timer was armed waited on the slow timer; the repainter now
  tracks the armed timer's due time and brings it forward for a faster pace.

Tests: predicate, pace selection, per-call interval, settle (fires once after
quiet, re-armed per chunk, never doubles up, cancelled by dispose), fast-forward
of a slow timer, slow never pushes fast later. Mutation-checked (settle bypassing
the throttle / interval ignored / old predicate / old timer logic each fail).
Needs the owner's live confirm on the slicer case (host cannot repro).
