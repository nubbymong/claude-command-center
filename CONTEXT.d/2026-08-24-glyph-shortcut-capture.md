# 2026-08-24 — Ctrl+Alt+G fired nowhere it mattered (beta.17 FYI item)

The glyph-corruption diagnostic chord (#374) was bound in the window's
BUBBLE-phase keydown listener. xterm's key handling stops propagation at its
textarea, so with the terminal focused — exactly where you are when glyphs go
missing — the chord never reached the handler. Everywhere else it worked,
which made "Ctrl+Alt+G does nothing" look untraceable.

Fix: the chord moved to its own CAPTURE-phase window listener (same
arbitration the tip card's Escape uses), keeping the AltGr guard (#399) and
the onboarding-overlay suppression. Success remains visible via main's
shell.showItemInFolder reveal.

Test `keyboard-glyph-capture.test.tsx` simulates xterm with a bubble-phase
stopPropagation interceptor: fails on a bubble-only listener (verified by
mutation), passes on capture; the AltGr chord is pinned inert.
